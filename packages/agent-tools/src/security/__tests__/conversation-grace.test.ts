import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { hasConversationGrace } from '../conversation-grace';

/**
 * La memoria corta del sí, fijada por sus dos promesas: encuentra la
 * aprobación que existe, y ante CUALQUIER duda responde tarjeta (false).
 */

interface Captured {
  filters: Record<string, unknown>;
  gte: Record<string, unknown>;
}

function stubDb(
  result: { data: Array<{ id: string }> | null; error: { message: string } | null },
  captured: Captured = { filters: {}, gte: {} },
): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      captured.filters[col] = val;
      return chain;
    },
    gte: (col: string, val: unknown) => {
      captured.gte[col] = val;
      return chain;
    },
    limit: () => Promise.resolve(result),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const OPTS = {
  conversationId: 'conv-1',
  userId: 'user-1',
  toolId: 'browser.open_page',
  graceMs: 15 * 60_000,
};

describe('la concesión de conversación', () => {
  it('encuentra el sí reciente, filtrando por conversación, usuario, herramienta y éxito', async () => {
    const captured: Captured = { filters: {}, gte: {} };
    const db = stubDb({ data: [{ id: 'a1' }], error: null }, captured);
    expect(await hasConversationGrace(db, OPTS)).toBe(true);
    // El ancla es la fila de auditoría de una ejecución CONFIRMADA: sin estos
    // cuatro filtros, un sí ajeno (otro hilo, otra persona, otra herramienta,
    // un intento fallido) abriría esta puerta.
    expect(captured.filters).toEqual({
      conversation_id: 'conv-1',
      user_id: 'user-1',
      tool_id: 'browser.open_page',
      status: 'ok',
    });
    expect(captured.gte.created_at).toBeTruthy();
  });

  it('sin aprobación previa: tarjeta', async () => {
    expect(await hasConversationGrace(stubDb({ data: [], error: null }), OPTS)).toBe(false);
  });

  it('sin conversación no hay concesión: una rutina o un MCP sin hilo no hereda nada', async () => {
    const db = stubDb({ data: [{ id: 'a1' }], error: null });
    expect(await hasConversationGrace(db, { ...OPTS, conversationId: undefined })).toBe(false);
  });

  it('la consulta que falla es tarjeta, no permiso', async () => {
    expect(
      await hasConversationGrace(stubDb({ data: null, error: { message: 'boom' } }), OPTS),
    ).toBe(false);
  });

  it('una ventana sin sentido (0 o negativa) nunca concede', async () => {
    const db = stubDb({ data: [{ id: 'a1' }], error: null });
    expect(await hasConversationGrace(db, { ...OPTS, graceMs: 0 })).toBe(false);
  });
});
