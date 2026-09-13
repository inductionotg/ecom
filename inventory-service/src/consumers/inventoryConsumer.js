import { PrismaClient } from '@prisma/client';
import { getChannel, EXCHANGE_NAME, INVENTORY_QUEUE_NAME } from '../config/rabbitmq.js';
import { InventoryService } from '../services/inventoryService.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();
const inventoryService = new InventoryService();

export async function startInventoryConsumer() {
  const channel = getChannel();

  logger.info(`Inventory Consumer listening on queue: ${INVENTORY_QUEUE_NAME}`);

  channel.consume(INVENTORY_QUEUE_NAME, async (msg) => {
    if (!msg) return;

    const eventId = msg.properties.messageId || `evt-${Date.now()}`;
    const routingKey = msg.fields.routingKey;
    const correlationId = msg.properties.headers?.correlationId || 'no-correlation-id';

    try {
      const data = JSON.parse(msg.content.toString());
      logger.info({ routingKey, eventId, correlationId }, 'Received message in Inventory Service');

      // 1. IDEMPOTENCY CHECK
      const alreadyProcessed = await prisma.processedEvent.findUnique({
        where: { eventId },
      });

      if (alreadyProcessed) {
        logger.warn({ eventId }, 'Event already processed by Inventory Consumer. Skipping duplicate.');
        channel.ack(msg);
        return;
      }

      // 2. DISPATCH BASED ON ROUTING KEY
      if (routingKey === 'order.ordercreated') {
        const { orderId, items } = data;

        try {
          // Attempt atomic reservation
          await inventoryService.reserveStock({ orderId, items });

          // PUBLISH SUCCESS: inventory.reserved
          // PUBLISH SUCCESS: inventory.reserved
          publishEvent('inventory.reserved', {
            orderId,
            totalAmount: data.totalAmount, // <-- Pass totalAmount forward!
            status: 'RESERVED',
          }, eventId, correlationId);

        } catch (reserveError) {
          // PUBLISH FAILURE: inventory.reservation_failed
          logger.warn({ orderId, err: reserveError.message }, 'Reservation failed. Emitting failure event.');
          
          publishEvent('inventory.reservation_failed', {
            orderId,
            reason: reserveError.message,
          }, eventId, correlationId);
        }

      } else if (routingKey === 'payment.failed') {
        // SAGA COMPENSATION: Release the held stock!
        const { orderId } = data;
        await inventoryService.releaseStock({ orderId });

        publishEvent('inventory.released', {
          orderId,
          status: 'RELEASED',
        }, eventId, correlationId);

      } else if (routingKey === 'payment.succeeded') {
        // SAGA COMMIT: Permanently finalize the stock deduction
        const { orderId } = data;
        await inventoryService.commitStock({ orderId });
      }

      // 3. RECORD PROCESSED EVENT FOR IDEMPOTENCY
      await prisma.processedEvent.create({
        data: {
          eventId,
          consumerName: 'inventory-service-consumer',
        },
      });

      // 4. ACKNOWLEDGE MESSAGE
      channel.ack(msg);

    } catch (err) {
      logger.error({ err: err.message, eventId }, 'Error processing inventory message');
      // Reject to Dead Letter Queue (DLQ) if unhandled
      channel.nack(msg, false, false);
    }
  });
}

// Helper to publish downstream events
function publishEvent(routingKey, payload, parentEventId, correlationId) {
  const channel = getChannel();
  channel.publish(
    EXCHANGE_NAME,
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    {
      persistent: true,
      messageId: `inv-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      headers: {
        parentEventId,
        correlationId,
        eventType: routingKey,
      },
    }
  );
  logger.info({ routingKey, correlationId }, 'Emitted downstream inventory event');
}