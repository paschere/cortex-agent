/**
 * The log, and one rule about it.
 *
 * NOTHING TYPED INTO A PAGE GOES IN HERE. Not the value of a fill step, not at
 * debug level, not inside an error object that happens to carry the step on it.
 * This process types other people's passwords into other people's login forms;
 * a log drain is a copy of everything in it, sitting somewhere with completely
 * different access rules from the encrypted column the password came out of.
 * Log the step index, the action, the selector kind, the duration, the error.
 * Never the value.
 *
 * Deliberately not pino. services/whatsapp needs pino because Baileys demands a
 * pino-shaped logger; nothing here does, and one dependency that must be kept
 * in step with a Chromium image is one too many. JSON lines on stdout is what
 * Railway ingests either way.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

/**
 * Keys whose values never reach the log, whatever anybody passes. A denylist is
 * the weaker half of the defence -- the strong half is that the call sites do
 * not pass values at all -- but it is the half that survives somebody adding a
 * field in a hurry six months from now.
 */
const FORBIDDEN = new Set([
  'value',
  'values',
  'secret',
  'secrets',
  'password',
  'clave',
  'contrasena',
  'token',
  'authorization',
  'cookie',
  'cookies',
  'inputs',
  'storageState',
]);

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = FORBIDDEN.has(key) ? '[redacted]' : value;
  }
  return out;
}

function emit(level: Level, fields: Record<string, unknown>, message: string): void {
  if (ORDER[level] < MIN) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: 'cortex-browser',
    msg: message,
    ...scrub(fields),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (fields: Record<string, unknown>, message: string) => emit('debug', fields, message),
  info: (fields: Record<string, unknown>, message: string) => emit('info', fields, message),
  warn: (fields: Record<string, unknown>, message: string) => emit('warn', fields, message),
  error: (fields: Record<string, unknown>, message: string) => emit('error', fields, message),
};
