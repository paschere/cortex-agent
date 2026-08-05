import pino from 'pino';

/**
 * The log, and one rule about it.
 *
 * MESSAGE CONTENT NEVER GOES IN HERE. Not at debug level, not "temporarily",
 * not in an error object that happens to carry a WhatsApp message on it. This
 * process reads other people's conversations — clients, suppliers, drivers —
 * and a log drain is a copy of everything in it, kept somewhere with entirely
 * different access rules from the Brain Knowledge space the operator chose. Log
 * the group id, the message id, the count, the error; never the words.
 *
 * Baileys is noisy at `debug` and useless below `warn`, so it gets its own
 * child logger pinned at `warn` — its internals are protocol chatter, and the
 * things worth knowing (connected, reconnecting, logged out) are logged by us.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'cortex-whatsapp' },
  redact: {
    paths: ['req.headers.authorization', 'creds', 'message', 'msg.message'],
    censor: '[redacted]',
  },
});

export const baileysLogger = logger.child({ component: 'baileys' }, { level: 'warn' });
