import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFICATION_KINDS } from '@/lib/notifications-shape';
import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { NotificationContractError, notify } from './notify';
import { noteRoutineRun } from './producers';
import { countUnread, listNotifications, markAllRead, markRead } from './repository';

/**
 * LO QUE UN AVISO NO PUEDE HACER MAL.
 *
 * Se prueba contra el fake de PostgREST de tenancy y, encima, contra el cliente
 * con alcance de verdad — el mismo `createOrgScopedClient` que corre en
 * producción. Eso importa para el bloque de aislamiento: si se probara con un
 * doble, se estaría probando el doble.
 *
 * El fake no genera ids ni defaults, así que `withIds` los pone al insertar,
 * que es lo único que Postgres hace y él no. Lo que el fake tampoco tiene es el
 * índice único parcial de la 0096, así que la carrera de dos escritores
 * simultáneos no se prueba aquí: es una garantía de la base, y probarla contra
 * un doble que no la implementa sería probar la nada.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';

let seq = 0;
function withIds(client: SupabaseClient): SupabaseClient {
  const inner = client as unknown as { from: (t: string) => Record<string, unknown> };
  return {
    from(table: string) {
      const builder = inner.from(table);
      const original = builder.insert as (rows: unknown) => unknown;
      builder.insert = (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list as Record<string, unknown>[]) {
          seq += 1;
          row.id ??= `${table}-${seq}`;
          row.created_at ??= new Date().toISOString();
          row.occurred_at ??= row.created_at;
          row.read_at ??= null;
          row.occurrences ??= 1;
        }
        return original.call(builder, list);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function world(tables: Tables = { notifications: [] }) {
  const fake = createFakeSupabase(tables);
  const raw = withIds(fake.client);
  return {
    tables,
    raw: fake.client,
    acme: createOrgScopedClient(raw, ACME),
    globex: createOrgScopedClient(raw, GLOBEX),
  };
}

function rows(tables: Tables): Record<string, unknown>[] {
  return (tables.notifications ?? []) as Record<string, unknown>[];
}

const FLOW = {
  kind: 'flow_finished',
  title: 'El trámite «Certificado de tradición» terminó',
  body: 'Quedó el documento en tus archivos.',
  href: '/browser',
  source: { kind: 'flow_run', id: 'run-1' },
} as const;

// ---------------------------------------------------------------------------
describe('escribir un aviso', () => {
  it('estampa el espacio de trabajo del handle, sin que nadie se lo pase', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });

    expect(rows(w.tables)).toHaveLength(1);
    expect(rows(w.tables)[0]).toMatchObject({
      organization_id: ACME,
      user_id: ANA,
      kind: 'flow_finished',
      // El tono sale de la clase cuando no se pide otro.
      tone: 'good',
    });
  });

  it('se niega a escribir con un handle sin espacio de trabajo', async () => {
    const w = world();
    await expect(notify(w.raw, { userId: ANA, ...FLOW })).rejects.toBeInstanceOf(
      NotificationContractError,
    );
    expect(rows(w.tables)).toHaveLength(0);
  });

  it('se niega a escribir sin destinatario', async () => {
    const w = world();
    await expect(notify(w.acme, { userId: '  ', ...FLOW })).rejects.toBeInstanceOf(
      NotificationContractError,
    );
    expect(rows(w.tables)).toHaveLength(0);
  });

  it('descarta un enlace que no sea una ruta interna, sin perder la noticia', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW, href: 'https://evil.example/pagar' });
    await notify(w.acme, {
      userId: ANA,
      ...FLOW,
      source: { kind: 'flow_run', id: 'run-2' },
      href: '//evil.example/pagar',
    });

    expect(rows(w.tables)).toHaveLength(2);
    expect(rows(w.tables).map((r) => r.href)).toEqual([null, null]);
  });

  it('no deja que un espacio de trabajo vea los avisos de otro', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.globex, { userId: ANA, ...FLOW });

    expect(await listNotifications(w.acme, ANA)).toHaveLength(1);
    expect(await listNotifications(w.globex, ANA)).toHaveLength(1);
    expect(await countUnread(w.acme, ANA)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('el agrupado', () => {
  it('funde lo mismo repetido en una sola fila con su contador', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, { userId: ANA, ...FLOW });

    expect(rows(w.tables)).toHaveLength(1);
    expect(rows(w.tables)[0]?.occurrences).toBe(3);
    expect(await countUnread(w.acme, ANA)).toBe(1);
  });

  it('deja de fundir en cuanto se leyó: lo mismo otra vez es noticia nueva', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await markAllRead(w.acme, ANA);
    await notify(w.acme, { userId: ANA, ...FLOW });

    expect(rows(w.tables)).toHaveLength(2);
    expect(await countUnread(w.acme, ANA)).toBe(1);
  });

  it('no funde avisos de dos personas aunque sean el mismo hecho', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, { userId: BETO, ...FLOW });

    expect(rows(w.tables)).toHaveLength(2);
    expect(await countUnread(w.acme, ANA)).toBe(1);
    expect(await countUnread(w.acme, BETO)).toBe(1);
  });

  it('separa lo que es distinto aunque venga del mismo origen', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, {
      userId: ANA,
      kind: 'flow_failed',
      title: 'El trámite «Certificado de tradición» no pudo terminar',
      source: { kind: 'flow_run', id: 'run-1' },
    });

    expect(rows(w.tables)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('contar y marcar', () => {
  it('cuenta sólo lo sin leer de esa persona', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, {
      userId: ANA,
      ...FLOW,
      source: { kind: 'flow_run', id: 'run-2' },
    });
    await notify(w.acme, { userId: BETO, ...FLOW });

    expect(await countUnread(w.acme, ANA)).toBe(2);
    expect(await countUnread(w.acme, BETO)).toBe(1);
  });

  it('marcar como leído NO toca los avisos de otra persona, ni por su id', async () => {
    const w = world();
    await notify(w.acme, { userId: BETO, ...FLOW });
    const ajeno = rows(w.tables)[0]?.id as string;

    // Ana nombra el aviso de Beto. No encaja con ninguna fila suya.
    expect(await markRead(w.acme, ANA, [ajeno])).toBe(0);
    expect(await countUnread(w.acme, BETO)).toBe(1);
  });

  it('marcar todo es de quien lo pide, y de nadie más de la empresa', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await notify(w.acme, { userId: BETO, ...FLOW });

    expect(await markAllRead(w.acme, ANA)).toBe(1);
    expect(await countUnread(w.acme, ANA)).toBe(0);
    expect(await countUnread(w.acme, BETO)).toBe(1);
  });

  it('no le mueve la hora de lectura a lo que ya estaba leído', async () => {
    const w = world();
    await notify(w.acme, { userId: ANA, ...FLOW });
    await markAllRead(w.acme, ANA);
    const first = rows(w.tables)[0]?.read_at;

    expect(await markAllRead(w.acme, ANA)).toBe(0);
    expect(rows(w.tables)[0]?.read_at).toBe(first);
  });

  it('un fallo de base al contar cuesta un número, no la navegación', async () => {
    const broken = createOrgScopedClient(
      {
        from: () => {
          throw new Error('la base dijo que no');
        },
      } as unknown as SupabaseClient,
      ACME,
    );
    expect(await countUnread(broken, ANA)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('la regla de qué merece un aviso', () => {
  const JOB = { id: 'job-1', name: 'Revisión de los lunes' };

  it('calla cuando la rutina salió bien y ya llegó por otro canal', async () => {
    const w = world();
    await noteRoutineRun(w.acme, {
      userId: ANA,
      job: JOB,
      runId: 'run-1',
      ok: true,
      deliveredElsewhere: true,
    });
    expect(rows(w.tables)).toHaveLength(0);
  });

  it('avisa cuando la rutina salió bien y no tenía ningún canal', async () => {
    const w = world();
    await noteRoutineRun(w.acme, {
      userId: ANA,
      job: JOB,
      runId: 'run-1',
      ok: true,
      deliveredElsewhere: false,
    });
    expect(rows(w.tables)).toHaveLength(1);
    expect(rows(w.tables)[0]?.kind).toBe('routine_finished');
  });

  it('avisa del fallo aunque la rutina tenga correo, y lo agrupa por rutina', async () => {
    const w = world();
    for (const runId of ['run-1', 'run-2', 'run-3']) {
      await noteRoutineRun(w.acme, {
        userId: ANA,
        job: JOB,
        runId,
        ok: false,
        error: 'La herramienta no contestó.',
        deliveredElsewhere: true,
      });
    }
    // Una rutina rota veinte veces es un problema con un contador, no veinte
    // campanadas.
    expect(rows(w.tables)).toHaveLength(1);
    expect(rows(w.tables)[0]).toMatchObject({ kind: 'routine_failed', occurrences: 3 });
  });

  it('no escribe nada cuando ya no hay a quién avisar', async () => {
    const w = world();
    await noteRoutineRun(w.acme, {
      userId: '',
      job: JOB,
      runId: 'run-1',
      ok: false,
      deliveredElsewhere: false,
    });
    expect(rows(w.tables)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('el vocabulario y la migración', () => {
  /**
   * El CHECK de `notifications.kind` y `NOTIFICATION_KINDS` tienen que decir lo
   * mismo. Añadir una clase en TypeScript sin migrarla compila, pasa el
   * typecheck y falla en producción con un 23514 dentro de un productor que se
   * traga el error — es decir, en silencio, que es la forma de fallar que este
   * módulo entero existe para evitar.
   */
  /**
   * Se lee el CHECK EFECTIVO, no el de una migración concreta.
   *
   * La 0096 lo escribió y la 0100 lo reescribió para añadir `report_ready`, y
   * habrá una tercera. Apuntar este test a un archivo fijo lo convierte en algo
   * que hay que acordarse de mover, que es exactamente el tipo de disciplina
   * que este test existe para no necesitar. Así que se recorren las migraciones
   * en orden y gana la última que define la lista.
   */
  it('la lista de clases es exactamente la del CHECK vigente en las migraciones', () => {
    const dir = fileURLToPath(new URL('../../../../infra/supabase/migrations', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let effective: string[] | null = null;
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      // Las dos formas que ha tomado: en línea al crear la tabla, y como
      // constraint con nombre al reescribirlo después.
      for (const marker of [
        // La 0096, en línea al crear la tabla.
        'kind             text not null check',
        // Cualquier migración posterior que lo reescriba con nombre.
        'add constraint notifications_kind_check',
      ]) {
        const at = sql.indexOf(marker);
        if (at < 0) continue;
        const block = sql.slice(at);
        effective = [...block.slice(0, block.indexOf('))')).matchAll(/'([a-z_]+)'/g)]
          .map((m) => m[1] as string)
          .filter((k) => k !== 'kind');
      }
    }

    expect(effective, 'ninguna migración define el CHECK de notifications.kind').not.toBeNull();
    expect([...(effective ?? [])].sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });
});
