import amqplib from 'amqplib';
import { logger } from '../utils/logger.js';

let connection = null;
let channel = null;

export const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'orderflow.events';
export const DLX_EXCHANGE = 'orderflow.dlx';
export const DLQ_QUEUE = 'orderflow.dlq';
export const PAYMENT_QUEUE_NAME = process.env.PAYMENT_QUEUE_NAME || 'payment_service_queue';

export async function connectRabbitMQ() {
  const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
  try {
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // 1. Assert DLX
    await channel.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });
    await channel.assertQueue(DLQ_QUEUE, { durable: true });
    await channel.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, 'dead-letter');

    // 2. Assert Main Topic Exchange
    await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

    // 3. Assert Payment Queue
    await channel.assertQueue(PAYMENT_QUEUE_NAME, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': DLX_EXCHANGE,
        'x-dead-letter-routing-key': 'dead-letter',
      },
    });

    // 4. BIND TO: inventory.reserved
    // Payment service ONLY cares when inventory has been reserved!
    await channel.bindQueue(PAYMENT_QUEUE_NAME, EXCHANGE_NAME, 'inventory.reserved');

    logger.info('Connected to RabbitMQ and asserted payment queues/bindings');
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