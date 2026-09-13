import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export class PaymentService {
  /**
   * Simulates charging a card.
   * If totalAmount > 5000 -> Simulates "Card Declined / Insufficient Funds"
   * Otherwise -> Simulates Successful Payment
   */
  async processPayment({ orderId, amount }) {
    logger.info({ orderId, amount }, 'Processing payment charge simulation');

    // Rule: Simulate decline if bill is over $5,000 (Great for testing failure sagas!)
    const isApproved = Number(amount) <= 5000;

    if (isApproved) {
      const transactionReference = `txn_mock_${crypto.randomUUID().substring(0, 8)}`;

      const payment = await prisma.payment.create({
        data: {
          orderId,
          amount,
          status: 'SUCCEEDED',
          transactionReference,
        },
      });

      logger.info({ orderId, transactionReference }, '💳 Payment APPROVED by bank');
      return { success: true, payment };
    } else {
      const failureReason = 'CARD_DECLINED: Amount exceeds maximum transaction limit ($5000)';

      const payment = await prisma.payment.create({
        data: {
          orderId,
          amount,
          status: 'FAILED',
          failureReason,
        },
      });

      logger.warn({ orderId, failureReason }, '❌ Payment DECLINED by bank');
      return { success: false, reason: failureReason, payment };
    }
  }

  async getPaymentByOrderId(orderId) {
    return prisma.payment.findUnique({
      where: { orderId },
    });
  }
}