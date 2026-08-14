import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { runWeeklyReport, summarizeForEmail, weeklyRecipients } from './weekly-report';

/**
 * LO ÚNICO QUE NO SE PUEDE FALLAR: QUE EL PARTE NO SALGA DOS VECES.
 *
 * ===========================================================================
 * POR QUÉ ESTA PRUEBA IMPLEMENTA UN ÍNDICE
 * ===========================================================================
 * El fake de PostgREST ejecuta filtros de verdad, pero no tiene índices, así
 * que tal cual aceptaría dos partes de la misma semana sin rechistar — y la
 * prueba pasaría mientras la garantía no existiera.
 *
 * Aquí se le pone encima exactamente el índice de la migración 0100:
 * `unique (organization_id, kind, period_start) where period_start is not null`,
 * devolviendo el mismo 23505 que devuelve Postgres. No es simular la base por
 * gusto: es que el mecanismo entero de «esto no se manda dos veces» ES ese
 * índice, y una prueba que no lo tenga delante está probando otra cosa.
 *
 * La parte que sí se prueba de verdad es lo que hace el código cuando el índice
 * contesta: que reclama ANTES de enviar, que no manda nada cuando pierde la
 * reclamación, y que no escribe una segunda fila.
 *
 * ===========================================================================
 * Y QUE EL AVISO SÓLO EXISTA CUANDO EL CORREO NO LLEGÓ
 * ===========================================================================
 * La 0096 dice que un aviso no repite lo que ya viajó por un canal que la
 * persona mira. Un parte que llega por correo Y suena la campana convierte la
 * campana en el sitio donde se relee lo ya leído, que es como muere un centro
 * de avisos. Así que hay una prueba para cada mitad.
 */

const ACME = 'org-acme';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';

const TODAY = '2026-08-03'; // lunes
const NOW = new Date('2026-08-03T12:00:00.000Z');
const WEEK_START = '2026-07-27';

/**
 * `reports_period_once_idx` de la 0100, y los ids que Postgres pone y el fake
 * no.
 */
function withIndexAndIds(client: SupabaseClient, tables: Tables): SupabaseClient {
  const inner = client as unknown as { from: (t: string) => Record<string, unknown> };
  let seq = 0;

  const conflict = {
    select: () => conflict,
    maybeSingle: () => conflict,
    single: () => conflict,
    then: <T>(onFulfilled: (v: unknown) => T) =>
      Promise.resolve({
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "reports_period_once_idx"',
        },
      }).then(onFulfilled),
  };

  return {
    from(table: string) {
      const builder = inner.from(table);
      const original = builder.insert as (rows: unknown) => unknown;
      builder.insert = (rows: unknown) => {
        const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
        for (const row of list) {
          seq += 1;
          row.id ??= `${table}-${seq}`;
          row.created_at ??= new Date().toISOString();
        }
        if (table === 'reports') {
          const existing = (tables.reports ?? []) as Record<string, unknown>[];
          for (const row of list) {
            if (row.period_start == null) continue; // el índice es PARCIAL
            const taken = existing.some(
              (r) =>
                r.organization_id === row.organization_id &&
                r.kind === row.kind &&
                r.period_start === row.period_start,
            );
            if (taken) return conflict;
          }
        }
        return original.call(builder, list);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function seed(over: Partial<Tables> = {}): Tables {
  return {
    users: [{ id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'org_admin' }],
    user_preferences: [],
    commitments: [
      {
        id: 'c-1',
        organization_id: ACME,
        title: 'Póliza de transporte',
        detail: null,
        kind: 'policy',
        counterparty: 'Seguros Bolívar',
        amount_cop: 2_000_000,
        due_on: '2026-08-05',
        notice_days: 30,
        state: 'in_force',
        met_at: null,
        met_by: null,
        met_note: null,
        dropped_at: null,
        dropped_reason: null,
        owner_user_id: ANA,
        escalate_to_user_id: null,
        escalate_after_days: 3,
        source_kind: 'manual',
        source_system: null,
        source_read_at: null,
        source_user_id: ANA,
        source_document_id: null,
        source_chunk_id: null,
        source_quote: null,
        review_state: 'confirmed',
        confirmed_at: null,
        confirmed_by: null,
        vehicle_id: null,
        recurrence: 'none',
        series_id: 's-1',
        previous_commitment_id: null,
        calendar_event_id: null,
        calendar_id: null,
        calendar_user_id: null,
        calendar_synced_due_on: null,
        calendar_error: null,
        created_by: ANA,
        created_at: '2026-06-01T00:00:00Z',
        updated_at: '2026-06-01T00:00:00Z',
      },
    ],
    actions: [],
    document_extractions: [],
    document_field_corrections: [],
    vehicles: [],
    vehicle_fines: [],
    payments: [],
    notifications: [],
    reports: [],
    ...over,
  };
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function world(tables: Tables = seed()) {
  const fake = createFakeSupabase(tables);
  const raw = withIndexAndIds(fake.client, tables);
  const sent: Sent[] = [];
  return {
    tables,
    sent,
    db: createOrgScopedClient(raw, ACME),
    mailer: (opts: Sent) => {
      sent.push(opts);
      return Promise.resolve({ sent: true });
    },
    failingMailer: (opts: Sent) => {
      sent.push(opts);
      return Promise.resolve({ sent: false, reason: 'RESEND_API_KEY no configurada' });
    },
  };
}

function reports(tables: Tables): Record<string, unknown>[] {
  return (tables.reports ?? []) as Record<string, unknown>[];
}
function notifications(tables: Tables): Record<string, unknown>[] {
  return (tables.notifications ?? []) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
describe('correrlo dos veces sobre la misma semana', () => {
  it('produce un solo informe y un solo correo', async () => {
    const w = world();

    const first = await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    expect(first.claimed).toBe(true);
    expect(first.reportId).toBeTruthy();
    expect(first.delivered).toBe(1);

    const second = await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    // Perdió la reclamación, y por eso no mandó nada. Ése es todo el mecanismo.
    expect(second.claimed).toBe(false);
    expect(second.reportId).toBeNull();
    expect(second.delivered).toBe(0);

    expect(reports(w.tables)).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it('aguanta diez pasadas seguidas, que es lo que hace un cron con reintentos', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) {
      await runWeeklyReport({
        db: w.db,
        today: TODAY,
        now: NOW,
        weekStart: WEEK_START,
        sendMail: w.mailer,
      });
    }
    expect(reports(w.tables)).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it('la semana siguiente sí es un parte nuevo: el índice acota por semana, no por tipo', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    const next = await runWeeklyReport({
      db: w.db,
      today: '2026-08-10',
      now: new Date('2026-08-10T12:00:00.000Z'),
      weekStart: '2026-08-03',
      sendMail: w.mailer,
    });
    expect(next.claimed).toBe(true);
    expect(reports(w.tables)).toHaveLength(2);
    expect(w.sent).toHaveLength(2);
  });

  it('la fila reclama su semana, y es del tipo que la migración añadió', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    expect(reports(w.tables)[0]).toMatchObject({
      organization_id: ACME,
      kind: 'weekly',
      period_start: WEEK_START,
      // Nadie lo pidió. Ésa es la característica, no un dato que falte.
      generated_by: null,
    });
  });
});

// ---------------------------------------------------------------------------
describe('el aviso, que sólo existe cuando el correo no llegó', () => {
  it('no suena la campana si el correo salió', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    expect(notifications(w.tables)).toHaveLength(0);
  });

  it('cuando el correo falla, deja el único rastro que queda de la semana', async () => {
    const w = world();
    const result = await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.failingMailer,
    });
    expect(result.failed).toBe(1);

    const notes = notifications(w.tables);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      organization_id: ACME,
      user_id: ANA,
      kind: 'report_ready',
      tone: 'warning',
    });
    // Y lleva a donde el parte sí está.
    expect(String(notes[0]?.href)).toContain('/reports/');
    expect(String(notes[0]?.body)).toContain('RESEND_API_KEY');
    // El informe se guardó igual: el correo es el canal, no el informe.
    expect(reports(w.tables)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('a quién le llega', () => {
  it('a los administradores, y la preferencia viene encendida sin tocar nada', async () => {
    const w = world();
    const people = await weeklyRecipients(w.db);
    expect(people).toEqual([{ userId: ANA, email: 'ana@acme.com' }]);
  });

  it('a nadie más: quien no es administrador no lo recibe aunque esté en la empresa', async () => {
    const w = world(
      seed({
        users: [
          { id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana', role: 'org_admin' },
          { id: BETO, organization_id: ACME, email: 'beto@acme.com', name: 'Beto', role: 'member' },
        ],
      }),
    );
    const people = await weeklyRecipients(w.db);
    expect(people.map((p) => p.email)).toEqual(['ana@acme.com']);
  });

  it('quien lo apaga deja de recibirlo, y entonces no sale ningún correo', async () => {
    const w = world(
      seed({
        user_preferences: [
          { user_id: ANA, organization_id: ACME, weekly_report_enabled: false },
        ],
      }),
    );
    expect(await weeklyRecipients(w.db)).toEqual([]);

    const result = await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    // Pero el parte se guarda igual: apagar el correo apaga el correo, no el
    // informe, que sigue estando en /reports para quien vaya a buscarlo.
    expect(result.claimed).toBe(true);
    expect(w.sent).toHaveLength(0);
    expect(reports(w.tables)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('lo que el correo dice', () => {
  it('lleva el hallazgo en el asunto, no el nombre del informe', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    const mail = w.sent[0];
    // Lo primero que se lee es la cifra que pide atención, no el nombre del
    // informe: en un teléfono el asunto se corta a los setenta caracteres.
    expect(mail?.subject.startsWith('Vence la semana que entra: 1')).toBe(true);
    expect(mail?.subject).toContain('parte semanal');
  });

  it('cuando la semana fue tranquila, el asunto lo dice en vez de alarmar', async () => {
    const w = world(seed({ commitments: [] }));
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    expect(w.sent[0]?.subject).toContain('nada pendiente de decidir');
  });

  it('las cifras del correo son las del informe, sin recalcular ninguna', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    const stored = reports(w.tables)[0]?.document as Parameters<typeof summarizeForEmail>[0];
    const summary = summarizeForEmail(stored);
    for (const f of summary.figures) {
      expect(w.sent[0]?.text).toContain(`${f.label}: ${f.display}`);
    }
  });

  it('el texto plano se sostiene solo: lleva las cifras y lo que el parte NO dice', async () => {
    const w = world();
    await runWeeklyReport({
      db: w.db,
      today: TODAY,
      now: NOW,
      weekStart: WEEK_START,
      sendMail: w.mailer,
    });
    const text = w.sent[0]?.text ?? '';
    expect(text).toContain('LAS CIFRAS');
    expect(text).toContain('QUÉ NO DICE ESTE PARTE');
    expect(text).toContain('Vence la semana que entra');
  });
});
