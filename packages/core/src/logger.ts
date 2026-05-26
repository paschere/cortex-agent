import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'zipdev-agent' },
  redact: { paths: ['access_token', 'refresh_token', '*.access_token', '*.refresh_token', 'authorization'], remove: true },
});
export type Logger = typeof logger;
