import { OrderService } from '../services/orderService.js';
import { logger } from '../utils/logger.js';
import { getDLQMessages } from '../config/rabbitmq.js';

const orderService = new OrderService();

export async function createOrderHandler(req, res) {
  try {
    const { userId, items } = req.body;

    // Input Validation
    if (!userId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payload: userId and a non-empty items array are required.',
      });
    }

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0 || item.unitPrice === undefined) {
        return res.status(400).json({
          success: false,
          message: 'Each item must have a valid productId, quantity > 0, and unitPrice >= 0.',
        });
      }
    }

    // Call service layer
    const order = await orderService.createOrder({ userId, items });

    // 202 Accepted: Order is received and queued for distributed processing
    return res.status(202).json({
      success: true,
      message: 'Order placed successfully and is being processed.',
      data: {
        orderId: order.id,
        status: order.status,
        totalAmount: order.totalAmount,
        items: order.items,
      },
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create order');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

export async function getOrderHandler(req, res) {
  try {
    const { id } = req.params;
    const order = await orderService.getOrderById(id);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get order');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

export async function getOrderMetricsHandler(req, res) {
  try {
    const metrics = await orderService.getOrderMetrics();
    return res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get metrics');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}


export async function getDLQHandler(req, res) {
  try {
    const data = await getDLQMessages();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to inspect DLQ');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}