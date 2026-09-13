import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { contextStorage } from './utils/context.js';
import { logger } from './utils/logger.js';
import { connectRabbitMQ } from './config/rabbitmq.js';
import { OutboxRelay } from './workers/outboxRelay.js';
import { startOrderConsumer } from './consumers/orderConsumer.js';
import {
  createOrderHandler,
  getOrderHandler,
  getOrderMetricsHandler,
  getDLQHandler, // <-- Add this import
} from './controllers/orderController.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Observability Middleware: Assign or extract Correlation ID
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  res.setHeader('x-correlation-id', correlationId);

  contextStorage.run({ correlationId }, () => {
    logger.info({ method: req.method, url: req.url }, 'Incoming HTTP request');
    next();
  });
});

// Routes
app.post('/api/orders', createOrderHandler);
app.get('/api/orders/:id', getOrderHandler);
app.get('/api/admin/metrics', getOrderMetricsHandler);
app.get('/api/admin/dlq', getDLQHandler);
// Health check
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'order-service' }));

// Start Server
async function bootstrap() {
  try {
    // 1. Connect RabbitMQ
    await connectRabbitMQ();

    // 2. Start Outbox Relay Worker
    const outboxRelay = new OutboxRelay(1000);
    outboxRelay.start();

    // 3. Start Saga Event Consumer
    await startOrderConsumer();

    // 4. Start HTTP Server
    app.listen(PORT, () => {
      logger.info(`Order Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start Order Service');
    process.exit(1);
  }
}

bootstrap();