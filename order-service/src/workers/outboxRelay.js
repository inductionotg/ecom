import { PrismaClient } from '@prisma/client';
import { getChannel, EXCHANGE_NAME } from '../config/rabbitmq.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export class OutboxRelay {
  constructor(intervalMs = 1000) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.isProcessing = false;
  }

  start() {
    logger.info('Outbox Relay Worker started');
    this.timer = setInterval(() => this.processOutbox(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    logger.info('Outbox Relay Worker stopped');
  }

  async processOutbox() {
    if (this.isProcessing) return; // Prevent overlapping runs
    this.isProcessing = true;

    try {
      // 1. Fetch up to 20 pending events (oldest first)
      const events = await prisma.outboxEvent.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      if (events.length === 0) {
        this.isProcessing = false;
        return;
      }

      const channel = getChannel();

      for (const event of events) {
        const routingKey = `order.${event.eventType.toLowerCase()}`;
        const messageBuffer = Buffer.from(JSON.stringify(event.payload));

        // 2. Publish to RabbitMQ Topic Exchange
        const published = channel.publish(
          EXCHANGE_NAME,
          routingKey,
          messageBuffer,
          {
            persistent: true,
            messageId: event.id,
            headers: {
              correlationId: event.correlationId,
              eventType: event.eventType,
            },
          }
        );

        if (published) {
          // 3. Mark as PUBLISHED
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: new Date(),
            },
          });

          logger.info(
            { eventId: event.id, routingKey, correlationId: event.correlationId },
            'Outbox event published to RabbitMQ successfully'
          );
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Error in Outbox Relay processing loop');
    } finally {
      this.isProcessing = false;
    }
  }
}