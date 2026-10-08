import { describe, expect, it } from 'vitest';
import { CHAT_ERRORS, classifyClientChatError, humanChatError } from './chat-error';

describe('el error que ve la persona', () => {
  it('un corte por tiempo dice que se acabó el tiempo, no «algo falló»', () => {
    expect(humanChatError('aborted', { deadline: true })).toBe(CHAT_ERRORS.timeout);
    expect(humanChatError('Vercel Runtime Timeout Error: Task timed out after 300 seconds')).toBe(
      CHAT_ERRORS.timeout,
    );
  });
  it('los demás casos conservan su frase', () => {
    expect(humanChatError('overloaded_error')).toBe(CHAT_ERRORS.busy);
    expect(humanChatError('fetch failed')).toBe(CHAT_ERRORS.cut);
    expect(humanChatError('prompt is too long: 210000 tokens')).toBe(CHAT_ERRORS.tooLong);
    expect(humanChatError("Cannot read properties of undefined (reading 'context')")).toBe(
      CHAT_ERRORS.generic,
    );
  });
  it('el cliente distingue un corte (Continuar) de un error (Reintentar)', () => {
    expect(classifyClientChatError(CHAT_ERRORS.timeout).kind).toBe('interrupted');
    expect(classifyClientChatError('network error')).toEqual({
      message: CHAT_ERRORS.cut,
      kind: 'interrupted',
    });
    expect(classifyClientChatError('TypeError: terminated').kind).toBe('interrupted');
    expect(classifyClientChatError(CHAT_ERRORS.generic).kind).toBe('error');
    expect(classifyClientChatError('Bad request').kind).toBe('error');
  });
});
