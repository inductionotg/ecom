import { PrismaClient } from '@prisma/client';
import { ProductCache } from '../cache/productCache.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export class InventoryService {
  /**
   * 1. ATOMIC STOCK RESERVATION
   * Handles high concurrency with zero overselling.
   */
  async reserveStock({ orderId, items }) {
    logger.info({ orderId, itemsCount: items.length }, 'Attempting atomic stock reservation');

    // Run everything inside an ACID transaction (All-or-Nothing)
    return await prisma.$transaction(async (tx) => {
      const reservedItems = [];

      for (const item of items) {
        const { productId, quantity } = item;

        // THE GOLDEN QUERY: Atomic check and lock at database level
        // Condition: (stock_total - stock_reserved) >= quantity
        const updated = await tx.$queryRaw`
          UPDATE "inventory_schema"."products"
          SET stock_reserved = stock_reserved + ${quantity},
              updated_at = NOW()
          WHERE id = ${productId}
            AND (stock_total - stock_reserved) >= ${quantity}
          RETURNING *;
        `;

        // If rowCount === 0, it means the item is OUT OF STOCK!
        if (!updated || updated.length === 0) {
          logger.warn({ orderId, productId, quantity }, 'Insufficient stock! Aborting reservation.');
          throw new Error(`INSUFFICIENT_STOCK: Product ${productId} does not have enough stock.`);
        }

        // Record the hold in inventory_reservations
        await tx.inventoryReservation.create({
          data: {
            orderId,
            productId,
            quantity,
            status: 'RESERVED',
          },
        });

        reservedItems.push(productId);
      }

      // Bust the Redis cache for all affected products
      for (const productId of reservedItems) {
        await ProductCache.invalidate(productId);
      }

      logger.info({ orderId, reservedItems }, 'All items successfully reserved!');
      return { success: true, orderId };
    });
  }

  /**
   * 2. SAGA COMPENSATION (ROLLBACK)
   * If Payment fails, release the reserved stock back to available!
   */
  async releaseStock({ orderId }) {
    logger.info({ orderId }, 'Running Saga Compensation: Releasing reserved stock');

    return await prisma.$transaction(async (tx) => {
      // Find all active reservations for this order
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderId, status: 'RESERVED' },
      });

      if (reservations.length === 0) {
        logger.warn({ orderId }, 'No active reservations found to release.');
        return { success: false };
      }

      for (const res of reservations) {
        // Return the items back to available stock (decrement stock_reserved)
        await tx.$queryRaw`
          UPDATE "inventory_schema"."products"
          SET stock_reserved = stock_reserved - ${res.quantity},
              updated_at = NOW()
          WHERE id = ${res.productId};
        `;

        // Mark reservation as RELEASED
        await tx.inventoryReservation.update({
          where: { id: res.id },
          data: { status: 'RELEASED' },
        });

        // Bust Redis cache so other shoppers immediately see the freed stock!
        await ProductCache.invalidate(res.productId);
      }

      logger.info({ orderId }, 'Reserved stock successfully released back to warehouse');
      return { success: true };
    });
  }

  /**
   * 3. SAGA SUCCESS (COMMIT)
   * Payment succeeded! Permanently deduct the stock.
   */
  async commitStock({ orderId }) {
    logger.info({ orderId }, 'Payment succeeded! Committing stock permanently');

    return await prisma.$transaction(async (tx) => {
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderId, status: 'RESERVED' },
      });

      for (const res of reservations) {
        // Permanently decrement stock_total and stock_reserved
        await tx.$queryRaw`
          UPDATE "inventory_schema"."products"
          SET stock_total = stock_total - ${res.quantity},
              stock_reserved = stock_reserved - ${res.quantity},
              updated_at = NOW()
          WHERE id = ${res.productId};
        `;

        // Mark reservation as COMMITTED
        await tx.inventoryReservation.update({
          where: { id: res.id },
          data: { status: 'COMMITTED' },
        });

        await ProductCache.invalidate(res.productId);
      }

      logger.info({ orderId }, 'Stock permanently committed');
      return { success: true };
    });
  }

  /**
   * 4. CACHE-ASIDE PRODUCT LOOKUP (Used by GET /products/:id)
   */
  async getProductById(productId) {
    // 1. Try Redis first (1ms)
    const cached = await ProductCache.get(productId);
    if (cached) return cached;

    // 2. Cache Miss -> Query PostgreSQL
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) return null;

    // Calculate available stock
    const productData = {
      ...product,
      stockAvailable: product.stockTotal - product.stockReserved,
    };

    // 3. Store in Redis for future shoppers
    await ProductCache.set(productId, productData);

    return productData;
  }
}