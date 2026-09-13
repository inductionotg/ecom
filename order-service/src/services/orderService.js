import { PrismaClient } from '@prisma/client';
import { getCorrelationId } from '../utils/context.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export class OrderService {
  async createOrder({ userId, items }) {
    const correlationId = getCorrelationId();

    // Calculate total bill
    const totalAmount = items.reduce((sum, item) => {
      return sum + Number(item.unitPrice) * item.quantity;
    }, 0);

    // ATOMIC TRANSACTION: Write Order + Items + OutboxEvent together
    const newOrder = await prisma.$transaction(async (tx) => {
      // 1. Insert into orders table
      const order = await tx.order.create({
        data: {
          userId,
          totalAmount,
          status: 'PENDING',
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      // 2. Insert into outbox_events table
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'ORDER',
          aggregateId: order.id,
          eventType: 'OrderCreated',
          payload: {
            orderId: order.id,
            userId: order.userId,
            totalAmount: order.totalAmount,
            items: order.items,
          },
          correlationId,
          status: 'PENDING',
        },
      });

      return order;
    });

    logger.info({ orderId: newOrder.id, totalAmount }, 'Order created and outbox event queued atomically');
    return newOrder;
  }

  async getOrderById(id) {
    return prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
  }

  // Advanced Reporting: Summary metrics
    // Advanced Reporting: Summary metrics
  async getOrderMetrics() {
    const metrics = await prisma.$queryRaw`
      SELECT 
        status, 
        COUNT(*)::INT as order_count, 
        COALESCE(SUM(total_amount), 0)::NUMERIC as total_revenue
      FROM orders
      GROUP BY status;
    `;

    // Convert any BigInt values to standard Numbers/Strings for JSON serialization
    return metrics.map((m) => ({
      status: m.status,
      orderCount: Number(m.order_count),
      totalRevenue: m.total_revenue?.toString() || '0.00',
    }));
  }
}