import { pino } from 'pino';
import { env } from './config/env.js';

/**
 * Structured JSON logs everywhere; pino-pretty only in development, so
 * production stdout stays machine-parseable (ARCHITECTURE.md §7).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'algoterminal', network: env.X402_NETWORK },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
