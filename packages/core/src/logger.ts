import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'cortex-agent' },
  redact: {
    paths: [
      'access_token',
      'refresh_token',
      'id_token',
      '*.access_token',
      '*.refresh_token',
      '*.id_token',
      'authorization',
      'Authorization',
      'cookie',
      '["set-cookie"]',
    ],
    remove: true,
  },
});
export type Logger = typeof logger;
