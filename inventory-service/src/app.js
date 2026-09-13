import 'dotenv/config';
import express from 'express';
import { logger } from './utils/logger.js';
import { connectRabbitMQ } from './config/rabbitmq.js';
import { redis } from './config/redis.js';
import { startInventoryConsumer } from './consumers/inventoryConsumer.js';
import { getProductHandler, listProductsHandler } from './controllers/productController.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// Routes
app.get('/api/products/:id', getProductHandler);
app.get('/api/products', listProductsHandler);
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'inventory-service' }));

async function bootstrap() {
  try {
    // 1. Connect RabbitMQ
    await connectRabbitMQ();

    // 2. Start Saga Event Consumer
    await startInventoryConsumer();

    // 3. Start HTTP Server
    app.listen(PORT, () => {
      logger.info(`Inventory Service running on port ${PORT}`);
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to bootstrap Inventory Service');
    process.exit(1);
  }
}

bootstrap();