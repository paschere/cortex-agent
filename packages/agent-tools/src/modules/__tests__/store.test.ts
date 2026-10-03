import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runTool } from '../../registry';
import type { ToolContext, ToolDef } from '../../types';
import { MODULES, MODULE_KEYS, moduleForTool } from '../catalog';
import { MODULE_PRESETS } from '../presets';
import {
  ModuleDisabledError,
  type ModuleRow,
  defaultModules,
  enabledModules,
  isModuleEnabled,
  planModuleChanges,
  previewModuleChanges,
  resolveModules,
  setModule,
  setModules,
  toolAllowedByModules,
  withoutDisabledModules,
} from '../store';

/**
 * Una base de mentira con lo justo: `company_modules` (leer y upsert),
 * `users` (el rol, para `isCompanyManager`) y `audit_events` (insert).
 */
function fakeDb(opts: { rows?: ModuleRow[]; role?: string; failRead?: boolean } = {}) {
  const rows: ModuleRow[] = [...(opts.rows ?? [])];
  const audits: Array<Record<string, unknown>> = [];
  const reads = { modules: 0 };
  const from = vi.fn((table: string) => {
    if (table === 'company_modules') {
      return {
        select: () => {
          reads.modules += 1;
          return Promise.resolve(
            opts.failRead
              ? { data: null, error: { message: 'se cayó la base' } }
              : { data: rows.map((r) => ({ ...r })), error: null },
          );
        },
        upsert: (values: ModuleRow[]) => {
          for (const v of values) {
            const i = rows.findIndex((r) => r.module_key === v.module_key);
            if (i >= 0) rows[i] = v;
            else rows.push(v);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    if (table === 'users') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { role: opts.role ?? 'member', email: null }, error: null }),
          }),
        }),
      };
    }
    if (table === 'audit_events') {
      return {
        insert: (row: Record<string, unknown>) => {
          audits.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    throw new Error(`tabla inesperada: ${table}`);
  });
  return { db: { from } as unknown as SupabaseClient, rows, audits, reads };
}

const ADMIN = '00000000-0000-0000-0000-0000000000aa';

describe('el catálogo', () => {
  it('cada módulo tiene clave conocida y sus dependencias existen', () => {
    for (const m of MODULES) {
      expect(MODULE_KEYS).toContain(m.key);
      for (const r of m.requires ?? []) expect(MODULE_KEYS).toContain(r);
    }
    expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULE_KEYS.length);
  });

  it('vencimientos gobierna sólo sus tres herramientas, no la lectura de documentos', () => {
    expect(moduleForTool('documents.expiring')?.key).toBe('doc_expirations');
    expect(moduleForTool('documents.track_expiration')?.key).toBe('doc_expirations');
    expect(moduleForTool('documents.extract')).toBeNull();
    expect(moduleForTool('documents.records')).toBeNull();
  });

  it('las herramientas de módulos no son de ningún módulo', () => {
    expect(moduleForTool('modules.list')).toBeNull();
    expect(moduleForTool('modules.set')).toBeNull();
  });
});

describe('qué tiene prendido una empresa', () => {
  it('sin filas, manda el estado por defecto del catálogo', async () => {
    const { db } = fakeDb();
    const on = await enabledModules(db);
    expect(on).toEqual(defaultModules());
    expect(on.has('finance')).toBe(true);
    expect(on.has('payroll')).toBe(false);
  });

  it('una fila gana al defecto, y una clave desconocida se ignora', () => {
    const on = resolveModules([
      { module_key: 'payroll', enabled: true },
      { module_key: 'finance', enabled: false },
      { module_key: 'algo_que_ya_no_existe', enabled: true },
    ]);
    expect(on.has('payroll')).toBe(true);
    expect(on.has('finance')).toBe(false);
    expect([...on].every((k) => (MODULE_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('lee una vez por handle aunque pregunten varias veces', async () => {
    const { db, reads } = fakeDb({ rows: [{ module_key: 'inventory', enabled: true }] });
    expect(await isModuleEnabled(db, 'inventory')).toBe(true);
    expect(await isModuleEnabled(db, 'fleet')).toBe(false);
    await enabledModules(db);
    expect(reads.modules).toBe(1);
  });

  it('si la lectura falla, cae al defecto sin lanzar y no lo recuerda', async () => {
    const { db, reads } = fakeDb({ failRead: true });
    expect(await enabledModules(db)).toEqual(defaultModules());
    await enabledModules(db);
    expect(reads.modules).toBe(2);
  });
});

describe('la regla de dependencias', () => {
  it('prender un módulo prende lo que necesita', () => {
    const current = new Set(defaultModules());
    current.delete('finance');
    current.delete('payables');
    const plan = planModuleChanges(current, [{ key: 'payables', enabled: true }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { key: 'payables', enabled: true },
        { key: 'finance', enabled: true },
      ]),
    );
  });

  it('apagar uno que otro prendido necesita se niega, en español, diciendo qué apagar', () => {
    const plan = planModuleChanges(defaultModules(), [{ key: 'finance', enabled: false }]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toBe(
      'No puedo apagar Finanzas: Cuentas por pagar lo necesita. Apaga primero Cuentas por pagar.',
    );
  });

  it('apagar los dos en el mismo cambio sí se puede', () => {
    const plan = planModuleChanges(defaultModules(), [
      { key: 'payables', enabled: false },
      { key: 'finance', enabled: false },
    ]);
    expect(plan.ok).toBe(true);
  });

  it('lo que no cambia no aparece', () => {
    const plan = planModuleChanges(defaultModules(), [{ key: 'finance', enabled: true }]);
    expect(plan).toMatchObject({ ok: true, changes: [] });
  });

  it('cada preset se puede aplicar desde el estado por defecto', () => {
    for (const p of MODULE_PRESETS) {
      const plan = previewModuleChanges(defaultModules(), p);
      expect(plan.ok, p.key).toBe(true);
      if (!plan.ok) continue;
      for (const k of p.on) expect(plan.next.has(k), `${p.key} prende ${k}`).toBe(true);
    }
  });
});

describe('cambiar un módulo', () => {
  it('sólo administradores o el dueño', async () => {
    const { db, rows } = fakeDb({ role: 'member' });
    await expect(
      setModule(db, { key: 'payroll', enabled: true, userId: ADMIN }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(rows).toEqual([]);
  });

  it('escribe lo que cambió, con dependencias, y deja auditoría', async () => {
    const { db, rows, audits } = fakeDb({
      role: 'org_admin',
      rows: [
        { module_key: 'finance', enabled: false },
        { module_key: 'payables', enabled: false },
      ],
    });
    const res = await setModule(db, { key: 'payables', enabled: true, userId: ADMIN });
    expect(res.changed.map((c) => c.key).sort()).toEqual(['finance', 'payables']);
    expect(rows.find((r) => r.module_key === 'finance')).toMatchObject({
      enabled: true,
      updated_by: ADMIN,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool_id: 'modules.toggle', status: 'ok' });
    // Lo recordado se olvida al escribir: la próxima lectura ya lo ve.
    expect(await isModuleEnabled(db, 'payables')).toBe(true);
  });

  it('se niega a apagar lo que otro necesita, sin escribir', async () => {
    const { db, rows } = fakeDb({ role: 'org_admin' });
    await expect(
      setModules(db, { changes: [{ key: 'statements', enabled: false }], userId: ADMIN }),
    ).rejects.toThrow(/Informe para socios lo necesita/);
    expect(rows).toEqual([]);
  });

  it('una clave desconocida es un error de validación', async () => {
    const { db } = fakeDb({ role: 'org_admin' });
    await expect(
      setModules(db, {
        changes: [{ key: 'nada' as unknown as 'finance', enabled: true }],
        userId: ADMIN,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('herramientas de un módulo apagado', () => {
  const tools = [{ id: 'payroll.team_overview' }, { id: 'ledger.query' }, { id: 'kb.search' }];

  it('no se ofrecen; las que no son de ningún módulo, siempre', () => {
    const on = new Set(defaultModules());
    expect(toolAllowedByModules('kb.search', on)).toBe(true);
    expect(toolAllowedByModules('payroll.team_overview', on)).toBe(false);
    expect(withoutDisabledModules(tools, on).map((t) => t.id)).toEqual([
      'ledger.query',
      'kb.search',
    ]);
  });

  function ctxFor(db: SupabaseClient): ToolContext {
    const noop = vi.fn();
    return {
      organizationId: 'org-test',
      userId: ADMIN,
      db,
      integrations: { getAccessToken: vi.fn(), hasScopes: vi.fn().mockResolvedValue(true) },
      logger: { info: noop, error: noop, warn: noop, debug: noop, trace: noop, fatal: noop },
    } as unknown as ToolContext;
  }

  const payrollTool: ToolDef<Record<string, never>, { ok: boolean }> = {
    id: 'payroll.modules_test_probe',
    description: 'probe',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler: vi.fn(async () => ({ ok: true })),
  };

  it('runTool la niega con la frase de Ajustes › Módulos y no corre el handler', async () => {
    const { db, audits } = fakeDb();
    const err = await runTool(payrollTool, {}, ctxFor(db)).catch((e) => e);
    expect(err).toBeInstanceOf(ModuleDisabledError);
    expect(err.message).toBe(
      'El módulo Nómina está apagado; un administrador lo prende en Ajustes › Módulos.',
    );
    expect(payrollTool.handler).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({
      tool_id: 'payroll.modules_test_probe',
      status: 'error',
      metadata: { reason: 'module_disabled', module: 'payroll' },
    });
  });
});

describe('el piloto con módulos apagados', () => {
  it('los recolectores de un módulo apagado no corren; los demás sí', async () => {
    const { collectAll, COLLECTORS } = await import('../../autopilot/collectors');
    const { fixtureSnapshot, FIXTURE_NOW } = await import('../../autopilot/autopilot.fixtures');
    for (const c of COLLECTORS) if (c.module) expect(MODULE_KEYS).toContain(c.module);

    const all = collectAll(fixtureSnapshot(), FIXTURE_NOW).items;
    const off = collectAll(
      { ...fixtureSnapshot(), modulesOff: ['finance', 'team', 'taxes'] },
      FIXTURE_NOW,
    ).items;
    expect(all.some((i) => i.area === 'finanzas')).toBe(true);
    expect(off.some((i) => i.area === 'finanzas')).toBe(false);
    expect(off.some((i) => i.area === 'equipo')).toBe(false);
    // La cobranza no es de ningún módulo: sigue.
    expect(off.filter((i) => i.area === 'cobro').length).toBe(
      all.filter((i) => i.area === 'cobro').length,
    );
  });
});
