import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_SECONDS = 300; // 5 minutes TTL

// Key helper: e.g. "product:prod_laptop_01"
const getProductKey = (productId) => `product:${productId}`;

export class ProductCache {
  // 1. Read from Redis Cache
  static async get(productId) {
    try {
      const data = await redis.get(getProductKey(productId));
      if (data) {
        logger.info({ productId }, '⚡ Redis Cache HIT');
        return JSON.parse(data);
      }
      logger.info({ productId }, '💨 Redis Cache MISS');
      return null;
    } catch (err) {
      logger.error({ err: err.message }, 'Redis GET error, falling back to DB');
      return null; // Fail-safe: if Redis is down, don't crash, fall back to Postgres
    }
  }

  // 2. Save into Redis Cache with TTL
  static async set(productId, productData) {
    try {
      await redis.setex(
        getProductKey(productId),
        CACHE_TTL_SECONDS,
        JSON.stringify(productData)
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Redis SET error');
    }
  }

  // 3. CACHE INVALIDATION: Bust the cache when stock changes!
  static async invalidate(productId) {
    try {
      await redis.del(getProductKey(productId));
      logger.info({ productId }, '🗑️ Redis Cache INVALIDATED for product');
    } catch (err) {
      logger.error({ err: err.message }, 'Redis DEL error');
    }
  }
}