import { PrismaClient } from '@prisma/client';
import { getChannel, EXCHANGE_NAME, PAYMENT_QUEUE_NAME } from '../config/rabbitmq.js';
import { PaymentService } from '../services/paymentService.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();
const paymentService = new PaymentService();

export async function startPaymentConsumer() {
  const channel = getChannel();

  logger.info(`Payment Consumer listening on queue: ${PAYMENT_QUEUE_NAME}`);

  channel.consume(PAYMENT_QUEUE_NAME, async (msg) => {
    if (!msg) return;

    const eventId = msg.properties.messageId || `pay-${Date.now()}`;
    const correlationId = msg.properties.headers?.correlationId || 'no-correlation-id';

    try {
      const data = JSON.parse(msg.content.toString());
      const { orderId } = data;

      logger.info({ orderId, eventId, correlationId }, 'Received inventory.reserved in Payment Service');

      // 1. IDEMPOTENCY CHECK (Prevents Double-Charging!)
      const alreadyProcessed = await prisma.processedEvent.findUnique({
        where: { eventId },
      });

      if (alreadyProcessed) {
        logger.warn({ eventId }, 'Payment event already processed. Skipping duplicate charge.');
        channel.ack(msg);
        return;
      }

      // To know how much to charge, let's look up the order total
      // Or in a real flow, inventory.reserved or order payload carries the total amount.
      // Here we default to 1225 (or data.totalAmount if passed):
      const amountToCharge = data.totalAmount || 1225;

      // 2. SIMULATE THE CHARGE
      const result = await paymentService.processPayment({
        orderId,
        amount: amountToCharge,
      });

      // 3. PUBLISH SAGA OUTCOME
      if (result.success) {
        // Broadcast Payment Succeeded
        publishSagaEvent('payment.succeeded', {
          orderId,
          paymentId: result.payment.id,
          amount: amountToCharge,
          status: 'SUCCEEDED',
        }, correlationId);
      } else {
        // Broadcast Payment Failed -> Triggers Inventory Release & Order Cancellation!
        publishSagaEvent('payment.failed', {
          orderId,
          reason: result.reason,
          status: 'FAILED',
        }, correlationId);
      }

      // 4. RECORD IDEMPOTENCY
      await prisma.processedEvent.create({
        data: {
          eventId,
          consumerName: 'payment-service-consumer',
        },
      });

      // 5. ACKNOWLEDGE
      channel.ack(msg);

    } catch (err) {
      logger.error({ err: err.message, eventId }, 'Error processing payment');
      channel.nack(msg, false, false);
    }
  });
}

function publishSagaEvent(routingKey, payload, correlationId) {
  const channel = getChannel();
  channel.publish(
    EXCHANGE_NAME,
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    {
      persistent: true,
      messageId: `pay-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      headers: {
        correlationId,
        eventType: routingKey === 'payment.succeeded' ? 'PaymentSucceeded' : 'PaymentFailed',
      },
    }
  );
  logger.info({ routingKey, correlationId }, 'Emitted payment saga outcome event');
}