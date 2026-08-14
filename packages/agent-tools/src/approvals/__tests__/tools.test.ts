import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../types';
import { approvalsListOutputSchema, pendingApprovalSchema, stagedViaOf } from '../shape';
import { approvalsList } from '../tools';

/**
 * QUE EL PAYLOAD NO PUEDA LLEGAR AL MODELO — PROBADO, NO REVISADO.
 *
 * `mcp_pending_actions.input` es la llamada entera que se ejecutará si alguien
 * dice que sí. Puede ser la exportación de una nómina. Que no acabe en el
 * contexto del modelo cada vez que alguien pregunta «¿qué me espera?» no puede
 * depender de que nadie escriba un spread de más dentro de un `map`, así que se
 * comprueba por los dos lados: que el ESQUEMA no tiene por dónde dejarlo pasar,
 * y que lo que la herramienta devuelve de verdad, con un payload sensible en la
 * fila, no contiene ni una de sus cadenas.
 */

const USER = '11111111-1111-4111-8111-111111111111';

/** Un payload que se reconoce a simple vista si se cuela por cualquier grieta. */
const SECRET = {
  spreadsheetId: 'NOMINA-2026-08',
  rows: [
    { empleado: 'Daniela Ríos', cedula: '1.020.304.050', salario: 18_400_000 },
    { empleado: 'Andrés Peña', cedula: '79.222.111', salario: 22_900_000 },
  ],
};

const ROW = {
  id: '44444444-4444-4444-8444-444444444444',
  tool_id: 'gsheets.append_row',
  created_at: '2026-08-13T12:00:00.000Z',
  expires_at: '2126-08-13T12:15:00.000Z',
  staged_via: 'mcp',
  input: SECRET,
};

/**
 * Un doble de la cadena de PostgREST que sólo sabe hacer lo que esta consulta
 * hace. Devuelve la fila ENTERA, `input` incluido: si el handler decidiera
 * pasarlo adelante, aquí lo tendría a mano — que es la única forma de que la
 * prueba signifique algo.
 */
function fakeDb(rows: unknown[] = [ROW]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'gt', 'order']) {
    chain[method] = () => chain;
  }
  chain.limit = async () => ({ data: rows, error: null });
  return { from: () => chain } as unknown as ToolContext['db'];
}

function ctx(db: ToolContext['db']): ToolContext {
  return {
    organizationId: 'org-a',
    userId: USER,
    agentId: '33333333-3333-4333-8333-333333333333',
    db,
    integrations: {
      getAccessToken: async () => ({ token: '', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger'],
  };
}

describe('approvals.list no puede devolver el payload', () => {
  it('el esquema de salida rechaza un `input`, en vez de podarlo en silencio', () => {
    const entry = {
      id: ROW.id,
      toolId: ROW.tool_id,
      summary: 'Agregar una fila a la hoja "NOMINA-2026-08"',
      createdAt: ROW.created_at,
      expiresAt: ROW.expires_at,
      via: 'mcp' as const,
    };

    expect(pendingApprovalSchema.safeParse(entry).success).toBe(true);

    // `.strict()` es la mitad importante: sin él zod se limitaría a quitar la
    // clave, la fuga tampoco ocurriría y NADIE SE ENTERARÍA. Con él, un intento
    // de colar el payload rompe `runTool` en la validación de salida.
    for (const smuggled of [
      { ...entry, input: SECRET },
      { ...entry, payload: SECRET },
      { ...entry, raw: JSON.stringify(SECRET) },
    ]) {
      expect(pendingApprovalSchema.safeParse(smuggled).success).toBe(false);
    }

    expect(
      approvalsListOutputSchema.safeParse({
        pending: [{ ...entry, input: SECRET }],
        summary: 'x',
      }).success,
    ).toBe(false);
  });

  it('no hay ninguna clave del esquema donde quepa un objeto', () => {
    // Todos los campos son cadenas (o el enum de origen). Un payload no cabe en
    // ninguno ni siquiera serializado como algo que se parezca a un dato.
    for (const key of ['id', 'toolId', 'summary', 'createdAt', 'expiresAt']) {
      const shape = pendingApprovalSchema.shape as Record<
        string,
        { safeParse(v: unknown): { success: boolean } }
      >;
      expect(shape[key]?.safeParse(SECRET).success, key).toBe(false);
    }
  });

  it('lo que devuelve de verdad no contiene ni una cadena del payload', async () => {
    const out = await approvalsList.handler({ limit: 10 }, ctx(fakeDb()));

    // La frase describe la llamada nombrando la hoja, que es lo que hace falta
    // para decidir — y nada más. Los nombres, las cédulas y los salarios no
    // aparecen por ninguna vía.
    const serialized = JSON.stringify(out);
    for (const needle of [
      'Daniela',
      'Andrés',
      '1.020.304.050',
      '79.222.111',
      '18400000',
      'salario',
    ]) {
      expect(serialized, needle).not.toContain(needle);
    }

    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]).toEqual({
      id: ROW.id,
      toolId: 'gsheets.append_row',
      summary: 'Agregar una fila a la hoja "NOMINA-2026-08"',
      createdAt: ROW.created_at,
      expiresAt: ROW.expires_at,
      via: 'mcp',
    });
    // Y pasa por su propio esquema, que es lo que `runTool` hará de todos modos.
    expect(approvalsListOutputSchema.safeParse(out).success).toBe(true);
  });

  it('una cola vacía se dice, no se dibuja en blanco', async () => {
    const out = await approvalsList.handler({ limit: 10 }, ctx(fakeDb([])));
    expect(out.pending).toEqual([]);
    expect(out.summary).toContain('No hay nada');
  });

  it('un origen que no reconocemos se lee como «no consta», nunca como «web»', () => {
    expect(stagedViaOf('mcp')).toBe('mcp');
    expect(stagedViaOf(null)).toBeNull();
    expect(stagedViaOf('telegram')).toBeNull();
  });
});

describe('approvals.decide no existe, y no es un descuido', () => {
  it('la familia registra exactamente una herramienta, y es de lectura', async () => {
    const { listTools } = await import('../../registry');
    const family = listTools().filter((t) => t.id.startsWith('approvals.'));
    expect(family.map((t) => t.id)).toEqual(['approvals.list']);
    // Nada que se llame aprobar, decidir, confirmar o ejecutar. Si algún día
    // alguien añade uno, esta prueba es donde tiene que venir a discutirlo —
    // ver la cabecera de approvals/tools.ts.
    expect(
      listTools().filter((t) => /^approvals\.(decide|approve|confirm|run|execute)/.test(t.id)),
    ).toEqual([]);
  });
});
