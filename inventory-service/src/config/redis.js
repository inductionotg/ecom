import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 2000);
    logger.warn(`Redis connection failed. Reconnecting in ${delay}ms...`);
    return delay;
  },
});

redis.on('connect', () => {
  logger.info('Connected to Redis Cache');
});

redis.on('error', (err) => {
  logger.error({ err: err.message }, 'Redis Client Error');
});