import { PrismaClient } from '@prisma/client';
import { getChannel, ORDER_QUEUE_NAME } from '../config/rabbitmq.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export async function startOrderConsumer() {
  const channel = getChannel();

  logger.info(`Order Consumer listening on queue: ${ORDER_QUEUE_NAME}`);

  channel.consume(ORDER_QUEUE_NAME, async (msg) => {
    if (!msg) return;

    const eventId = msg.properties.messageId || 'unknown-id';
    const eventType = msg.properties.headers?.eventType;
    const routingKey = msg.fields.routingKey;
    const correlationId = msg.properties.headers?.correlationId;

    try {
      const data = JSON.parse(msg.content.toString());
      const { orderId, reason } = data;

      // 1. IDEMPOTENCY CHECK
      const alreadyProcessed = await prisma.processedEvent.findUnique({
        where: { eventId },
      });

      if (alreadyProcessed) {
        logger.warn({ eventId, correlationId }, 'Event already processed. Skipping duplicate.');
        channel.ack(msg);
        return;
      }

      // 2. Update Order status inside a transaction with ProcessedEvent
      await prisma.$transaction(async (tx) => {
        if (eventType === 'PaymentSucceeded' || routingKey === 'payment.succeeded') {
          await tx.order.update({
            where: { id: orderId },
            data: { status: 'CONFIRMED' },
          });
          logger.info({ orderId, correlationId }, '🎉 Order successfully CONFIRMED!');
        } else if (
          eventType === 'PaymentFailed' || 
          routingKey === 'payment.failed' || 
          routingKey === 'inventory.reservation_failed'
        ) {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: 'FAILED',
              failureReason: reason || 'Saga step failed',
            },
          });
          logger.warn({ orderId, correlationId, reason }, 'Order marked as FAILED');
        }

        // 3. Mark event as processed
        await tx.processedEvent.create({
          data: {
            eventId,
            consumerName: 'order-service-consumer',
          },
        });
      });

      // 4. Acknowledge message
      channel.ack(msg);
    } catch (error) {
      logger.error({ error: error.message, eventId }, 'Failed to process saga message');
      channel.nack(msg, false, false);
    }
  });
}