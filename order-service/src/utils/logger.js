import pino from 'pino';
import { getCorrelationId } from './context.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  mixin() {
    return { correlationId: getCorrelationId() };
  },
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined,
});