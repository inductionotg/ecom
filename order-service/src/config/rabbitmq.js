import amqplib from 'amqplib';
import { logger } from '../utils/logger.js';

let connection = null;
let channel = null;

export const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'orderflow.events';
export const DLX_EXCHANGE = 'orderflow.dlx';
export const DLQ_QUEUE = 'orderflow.dlq';
export const ORDER_QUEUE_NAME = process.env.ORDER_QUEUE_NAME || 'order_service_queue';

export async function connectRabbitMQ() {
  const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
  try {
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // 1. Assert Dead Letter Exchange (DLX) & Dead Letter Queue (DLQ)
    await channel.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });
    await channel.assertQueue(DLQ_QUEUE, { durable: true });
    await channel.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, 'dead-letter');

    // 2. Assert Main Topic Exchange
    await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

    // 3. Assert Order Service Queue (receives saga outcomes from payment & inventory)
    await channel.assertQueue(ORDER_QUEUE_NAME, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DLX_EXCHANGE,
        'x-dead-letter-routing-key': 'dead-letter',
      },
    });

    // Bind queue to saga outcomes
    await channel.bindQueue(ORDER_QUEUE_NAME, EXCHANGE_NAME, 'payment.succeeded');
    await channel.bindQueue(ORDER_QUEUE_NAME, EXCHANGE_NAME, 'payment.failed');
    await channel.bindQueue(ORDER_QUEUE_NAME, EXCHANGE_NAME, 'inventory.reservation_failed');

    logger.info('Connected to RabbitMQ and asserted exchanges/queues');
    return { connection, channel };
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to connect to RabbitMQ');
    throw error;
  }
}

export function getChannel() {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized! Call connectRabbitMQ() first.');
  }
  return channel;
}

// Inspect messages sitting in the Dead Letter Queue without consuming them
export async function getDLQMessages(limit = 10) {
  if (!channel) throw new Error('RabbitMQ channel not connected');

  const messages = [];
  const queueInfo = await channel.checkQueue(DLQ_QUEUE);

  logger.info({ messageCount: queueInfo.messageCount }, 'Inspecting Dead Letter Queue');

  // Peek messages using get() with noAck: false
  for (let i = 0; i < Math.min(queueInfo.messageCount, limit); i++) {
    const msg = await channel.get(DLQ_QUEUE, { noAck: false });
    if (msg) {
      messages.push({
        messageId: msg.properties.messageId,
        headers: msg.properties.headers,
        routingKey: msg.fields.routingKey,
        payload: JSON.parse(msg.content.toString()),
      });
      // Re-queue it so inspecting does not destroy the message!
      channel.nack(msg, false, true);
    }
  }

  return {
    totalDeadMessages: queueInfo.messageCount,
    inspectedMessages: messages,
  };
}