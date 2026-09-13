import 'dotenv/config';
import express from 'express';
import { logger } from './utils/logger.js';
import { connectRabbitMQ } from './config/rabbitmq.js';
import { startPaymentConsumer } from './consumers/paymentConsumer.js';
import { PaymentService } from './services/paymentService.js';

const app = express();
const PORT = process.env.PORT || 3003;
const paymentService = new PaymentService();

app.use(express.json());

// Audit Endpoint: View payment details for an order
app.get('/api/payments/:orderId', async (req, res) => {
  try {
    const payment = await paymentService.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    return res.status(200).json({ success: true, data: payment });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'payment-service' }));

async function bootstrap() {
  try {
    // 1. Connect RabbitMQ
    await connectRabbitMQ();

    // 2. Start Saga Payment Consumer
    await startPaymentConsumer();

    // 3. Start Server
    app.listen(PORT, () => {
      logger.info(`Payment Service running on port ${PORT}`);
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start Payment Service');
    process.exit(1);
  }
}

bootstrap();