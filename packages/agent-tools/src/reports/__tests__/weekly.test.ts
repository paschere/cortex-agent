import type { Tables } from '../../tenancy/__tests__/fake-postgrest';
import { describe, expect, it } from 'vitest';
import { type GroupByPerson, buildWeekly, mondayOf } from '../build';
import { figuresOf } from '../document';
import { renderReportHtml } from '../render';
import { ACME, ANA, CARLA, GLOBEX, fixture, world } from './fixture';

/**
 * EL PARTE SEMANAL, QUE ES EL ÚNICO INFORME QUE NADIE PIDE.
 *
 * Las tres cosas que se prueban aquí, en este orden de importancia:
 *
 *   1. QUE NO MIENTE POR OMISIÓN NI POR SOBRA. Una promesa entre colegas no
 *      cuenta como un papel que vence, y lo cumplido la semana pasada son las
 *      filas de la semana pasada y no las quinientas más antiguas de la tabla.
 *      Las dos son formas de equivocarse que no fallan: contestan con
 *      confianza y con números redondos.
 *
 *   2. QUE NO CRUZA EMPRESAS. Un parte suma y agrupa, que es el peor sitio del
 *      producto para perder el filtro de espacio de trabajo: una fila ajena no
 *      aparece como fila, aparece dentro de un total. Globex lleva cifras
 *      absurdas a propósito para que una fuga se vea de un vistazo.
 *
 *   3. QUE UNA EMPRESA NUEVA RECIBE ALGO QUE SE PUEDE LEER. El parte de una
 *      base vacía no puede ser una plantilla con ceros: tiene que decir que no
 *      hay nada anotado y que eso, en sí, es el hallazgo.
 */

const TODAY = '2026-08-03'; // lunes
const NOW = new Date('2026-08-03T12:00:00.000Z');
const WEEK_START = '2026-07-27';
const WEEK_END = '2026-08-02';

/**
 * Un agrupado por persona de mentira, con la MISMA forma que `buildPeopleLoad`.
 *
 * El de verdad vive en la aplicación (un paquete no puede importar de una app)
 * y se ejercita entero en `apps/web/lib/weekly-report.test.ts`, que llama al
 * recorrido completo. Aquí sólo hace falta algo que devuelva la forma acordada,
 * para poder comprobar que el constructor la pinta.
 */
const groupByPerson: GroupByPerson = ({ open }) => {
  const byOwner = new Map<string, ReturnType<typeof blank>>();
  function blank(name: string, unassigned: boolean) {
    return {
      name,
      unassigned,
      promises: { open: 0, overdue: 0 },
      papers: { open: 0, overdue: 0 },
      items: [] as Array<{
        title: string;
        internal: boolean;
        dueOn: string;
        daysLeft: number;
        stateLabel: string;
      }>,
    };
  }
  for (const row of open) {
    const key = row.owner_user_id ?? '__sin__';
    const person =
      byOwner.get(key) ?? blank(row.owner_name ?? 'Sin responsable', !row.owner_user_id);
    const tally = row.kind === 'internal' ? person.promises : person.papers;
    tally.open += 1;
    person.items.push({
      title: row.title,
      internal: row.kind === 'internal',
      dueOn: row.due_on,
      daysLeft: 0,
      stateLabel: 'Vigente',
    });
    byOwner.set(key, person);
  }
  return { pending: [...byOwner.values()] };
};

function commitment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    detail: null,
    counterparty: null,
    amount_cop: null,
    notice_days: 30,
    state: 'in_force',
    met_at: null,
    met_by: null,
    met_note: null,
    dropped_at: null,
    dropped_reason: null,
    owner_user_id: null,
    escalate_to_user_id: null,
    escalate_after_days: 3,
    source_kind: 'manual',
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    review_state: 'confirmed',
    confirmed_at: null,
    confirmed_by: null,
    vehicle_id: null,
    recurrence: 'none',
    previous_commitment_id: null,
    calendar_event_id: null,
    calendar_id: null,
    calendar_user_id: null,
    calendar_synced_due_on: null,
    calendar_error: null,
    created_by: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function action(over: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: ANA,
    agent_id: null,
    conversation_id: null,
    kind: 'collect_payment',
    tool_id: 'gmail.send_message',
    tool_input: { to: 'pagos@servientrega.com', subject: 'Cobro', body: 'x' },
    content_hash: 'a'.repeat(64),
    recipient: 'pagos@servientrega.com',
    subject: 'Cobro factura 1',
    origin_kind: 'commitment',
    origin_id: null,
    rationale: 'Lleva 40 días',
    client_id: null,
    state: 'proposed',
    expires_at: '2026-08-10T00:00:00Z',
    decided_at: null,
    decided_by: null,
    decided_via: null,
    dismissed_reason: null,
    executed_at: null,
    execution_status: null,
    execution_error: null,
    execution_result: null,
    thread_id: null,
    outcome: 'none',
    outcome_at: null,
    outcome_note: null,
    edited_count: 0,
    created_at: '2026-07-28T10:00:00Z',
    updated_at: '2026-07-28T10:00:00Z',
    ...over,
  };
}

/** El mundo compartido, más todo lo que el parte lee y los otros informes no. */
function weeklyTables(): Tables {
  const tables = fixture();
  (tables.commitments as Record<string, unknown>[]).push(
    // Vence dentro de la semana que entra: es la cifra que abre el parte.
    commitment({
      id: 'c-acme-next',
      organization_id: ACME,
      title: 'Póliza de transporte',
      kind: 'policy',
      counterparty: 'Seguros Bolívar',
      amount_cop: 2_000_000,
      due_on: '2026-08-05',
      owner_user_id: ANA,
      series_id: 's-acme-next',
    }),
    // Una promesa entre colegas. NO es un papel que vence: no puede salir en la
    // sección de vencimientos, y sí en la de quién debe qué.
    commitment({
      id: 'c-acme-promise',
      organization_id: ACME,
      title: 'Ana quedó de mandar el informe',
      kind: 'internal',
      due_on: '2026-08-06',
      owner_user_id: ANA,
      series_id: 's-acme-promise',
    }),
    // Cumplido DENTRO de la semana reportada.
    commitment({
      id: 'c-acme-met',
      organization_id: ACME,
      title: 'Radicado DIAN',
      kind: 'other',
      due_on: '2026-07-30',
      state: 'met',
      met_at: '2026-07-29T15:00:00Z',
      owner_user_id: ANA,
      series_id: 's-acme-met',
    }),
    // Cumplido hace año y medio. Sin `metAfter` sería la primera fila que
    // devuelve la consulta, y el parte lo presentaría como de esta semana.
    commitment({
      id: 'c-acme-old',
      organization_id: ACME,
      title: 'Trámite viejísimo',
      kind: 'other',
      due_on: '2024-01-10',
      state: 'met',
      met_at: '2024-01-09T15:00:00Z',
      owner_user_id: ANA,
      series_id: 's-acme-old',
    }),
    commitment({
      id: 'c-globex-met',
      organization_id: GLOBEX,
      title: 'Radicado secretísimo de Globex',
      kind: 'other',
      due_on: '2026-07-30',
      state: 'met',
      met_at: '2026-07-29T15:00:00Z',
      owner_user_id: CARLA,
      series_id: 's-globex-met',
    }),
  );

  tables.actions = [
    action({ id: 'a-acme-1', organization_id: ACME, subject: 'Cobro factura Acme' }),
    action({
      id: 'a-acme-2',
      organization_id: ACME,
      subject: 'Cobro que nadie contestó',
      state: 'approved',
      decided_at: '2026-07-28T12:00:00Z',
      executed_at: '2026-07-20T12:00:00Z',
      execution_status: 'ok',
      outcome: 'no_reply',
      outcome_at: '2026-07-30T12:00:00Z',
    }),
    action({
      id: 'a-globex-1',
      organization_id: GLOBEX,
      user_id: CARLA,
      subject: 'Cobro secretísimo de Globex',
      state: 'approved',
      decided_at: '2026-07-28T12:00:00Z',
      executed_at: '2026-07-20T12:00:00Z',
      execution_status: 'ok',
      outcome: 'no_reply',
      outcome_at: '2026-07-30T12:00:00Z',
    }),
  ];

  tables.document_extractions = [
    {
      id: 'e-acme-1',
      organization_id: ACME,
      document_id: 'd-acme-1',
      doc_type: 'invoice',
      counterparty_name: 'Servientrega',
      doc_number: 'FE-9001',
      review_state: 'pending',
      created_at: '2026-07-10T00:00:00Z',
    },
    {
      id: 'e-globex-1',
      organization_id: GLOBEX,
      document_id: 'd-globex-1',
      doc_type: 'invoice',
      counterparty_name: 'Contraparte secretísima de Globex',
      doc_number: 'FE-7777',
      review_state: 'pending',
      created_at: '2026-07-10T00:00:00Z',
    },
  ];

  tables.document_field_corrections = [
    {
      id: 'fc-acme-1',
      organization_id: ACME,
      field_id: null,
      extraction_id: 'e-acme-1',
      doc_type: 'invoice',
      field_key: 'total_amount',
      proposed_display: '1.000',
      corrected_display: '1.000.000',
      outcome: 'corrected',
      corrected_by: ANA,
      corrected_at: '2026-07-29T10:00:00Z',
    },
    {
      id: 'fc-globex-1',
      organization_id: GLOBEX,
      field_id: null,
      extraction_id: 'e-globex-1',
      doc_type: 'invoice',
      field_key: 'due_on',
      proposed_display: 'x',
      corrected_display: 'y',
      outcome: 'rejected',
      corrected_by: CARLA,
      corrected_at: '2026-07-29T10:00:00Z',
    },
  ];

  tables.payments = [];
  return tables;
}

async function weeklyFor(organizationId: string, tables: Tables = weeklyTables()) {
  const w = world(tables);
  return buildWeekly({
    db: w.db(organizationId),
    today: TODAY,
    now: NOW,
    weekStart: WEEK_START,
    groupByPerson,
  });
}

describe('la semana que reporta', () => {
  it('el lunes de una fecha es el lunes de esa semana, y el domingo cuenta como el final', () => {
    expect(mondayOf('2026-08-03')).toBe('2026-08-03'); // lunes
    expect(mondayOf('2026-08-05')).toBe('2026-08-03'); // miércoles
    // El caso que se rompe con la aritmética ingenua: el domingo pertenece a la
    // semana que empezó el lunes anterior, no a la que empieza mañana.
    expect(mondayOf('2026-08-09')).toBe('2026-08-03');
  });

  it('el periodo por defecto es la semana que acaba de cerrar', async () => {
    const w = world(weeklyTables());
    const doc = await buildWeekly({
      db: w.db(ACME),
      today: TODAY,
      now: NOW,
      groupByPerson,
    });
    expect(doc.periodLabel).toContain('27 de julio de 2026');
    expect(doc.periodLabel).toContain('2 de agosto de 2026');
  });
});

describe('el parte de una empresa con datos', () => {
  it('cuenta lo que vence la semana que entra sin meter las promesas internas', async () => {
    const doc = await weeklyFor(ACME);
    const next = figuresOf(doc).find((f) => f.label === 'Vence la semana que entra');
    // Sólo la póliza del 5 de agosto. La promesa de Ana vence el 6 y no cuenta.
    expect(next?.figure.raw).toBe(1);

    const html = renderReportHtml(doc);
    expect(html).toContain('Póliza de transporte');
    // La promesa NO puede aparecer en la línea de vencimientos: ahí se cuentan
    // papeles con terceros. Aparece en «quién debe qué», y como conteo aparte.
    expect(html).not.toContain('Ana quedó de mandar el informe');

    const people = doc.sections.find((s) => s.type === 'table' && s.heading === 'Quién debe qué');
    expect(people?.type).toBe('table');
    const ana = people?.type === 'table' ? people.table.rows.find((r) => r[0]?.display === 'Ana') : undefined;
    // Columnas: persona, papeles, papeles vencidos, promesas, promesas vencidas.
    expect(ana?.[1]?.display).toBe('1'); // la póliza
    expect(ana?.[3]?.display).toBe('1'); // la promesa, contada aparte
  });

  it('lo cumplido es lo de ESTA semana, no las filas más antiguas de la tabla', async () => {
    const doc = await weeklyFor(ACME);
    const met = figuresOf(doc).find((f) => f.label === 'Se cumplió');
    expect(met?.figure.raw).toBe(1);

    const html = renderReportHtml(doc);
    expect(html).toContain('Radicado DIAN');
    // Ésta es la prueba del `metAfter`: sin él, el trámite de 2024 sería la
    // primera fila devuelta y el parte lo presentaría como de la semana pasada.
    expect(html).not.toContain('Trámite viejísimo');
  });

  it('los silencios son el hallazgo, y salen con su antigüedad', async () => {
    const doc = await weeklyFor(ACME);
    const silence = figuresOf(doc).find((f) => f.label === 'Sin respuesta');
    expect(silence?.figure.raw).toBe(1);
    expect(renderReportHtml(doc)).toContain('Cobro que nadie contestó');
  });

  it('reporta sus propios errores de lectura', async () => {
    const doc = await weeklyFor(ACME);
    const html = renderReportHtml(doc);
    expect(html).toContain('Dónde me equivoco leyendo');
    expect(doc.sources.find((s) => s.id === 'document_field_corrections')?.rowCount).toBe(1);
  });

  it('cada cifra resuelve a una fuente declarada, con su momento y sus filas', async () => {
    const doc = await weeklyFor(ACME);
    const declared = new Set(doc.sources.map((s) => s.id));
    for (const { figure } of figuresOf(doc)) {
      expect(declared.has(figure.sourceId)).toBe(true);
      expect(figure.method.length).toBeGreaterThan(20);
    }
    for (const s of doc.sources) expect(s.readAt).toBe(NOW.toISOString());
  });

  it('no dice una palabra sobre ingresos, crecimiento ni márgenes', async () => {
    const html = renderReportHtml(await weeklyFor(ACME)).toLowerCase();
    for (const word of ['ingresos', 'crecimiento', 'margen', 'todo va bien']) {
      // La única aparición admisible sería la nota que dice que NO se dicen, y
      // esa nota nombra las tres juntas en una frase que sí está permitida.
      const forbidden = html.split('no hay ingresos')[0] ?? '';
      expect(forbidden).not.toContain(word);
    }
  });
});

describe('el parte no cruza empresas', () => {
  it('Acme no ve una sola fila de Globex, en ninguna sección', async () => {
    const html = renderReportHtml(await weeklyFor(ACME));
    expect(html).not.toContain('Globex');
    expect(html).not.toContain('999.999.999');
    expect(html).not.toContain('777.777.777');
  });

  it('Globex ve las suyas, y ninguna de Acme', async () => {
    const html = renderReportHtml(await weeklyFor(GLOBEX));
    expect(html).toContain('Cobro secretísimo de Globex');
    expect(html).not.toContain('Radicado DIAN');
    expect(html).not.toContain('Cobro que nadie contestó');
    expect(html).not.toContain('Póliza de transporte');
  });

  it('los conteos de las fuentes son los de cada empresa, no los de la tabla', async () => {
    const acme = await weeklyFor(ACME);
    const globex = await weeklyFor(GLOBEX);
    expect(acme.sources.find((s) => s.id === 'actions_silence')?.rowCount).toBe(1);
    expect(globex.sources.find((s) => s.id === 'actions_silence')?.rowCount).toBe(1);
    expect(acme.sources.find((s) => s.id === 'document_extractions')?.rowCount).toBe(1);
  });
});

describe('el parte de una empresa nueva', () => {
  it('se construye entero y dice que no hay nada anotado en vez de fingir ceros', async () => {
    const doc = await weeklyFor('org-vacia', {
      users: [],
      commitments: [],
      vehicles: [],
      vehicle_fines: [],
      kb_documents: [],
      actions: [],
      document_extractions: [],
      document_field_corrections: [],
      payments: [],
      reports: [],
    });

    expect(doc.kind).toBe('weekly');
    expect(doc.sources.length).toBeGreaterThan(0);
    for (const s of doc.sources) expect(s.rowCount).toBe(0);

    const html = renderReportHtml(doc);
    expect(html).toContain('no tengo nada que reportar');
    // Y la razón por la que eso puede ser un hallazgo y no una buena noticia.
    expect(html).toContain('no se está anotando en ninguna parte');
  });

  it('sin cartera, lo dice en las notas en vez de dibujar una sección vacía', async () => {
    const doc = await weeklyFor('org-vacia', {
      users: [],
      commitments: [],
      vehicles: [],
      vehicle_fines: [],
      actions: [],
      document_extractions: [],
      document_field_corrections: [],
      payments: [],
      reports: [],
    });
    expect(doc.sections.some((s) => 'heading' in s && s.heading === 'La cartera')).toBe(false);
    expect(doc.notes.join(' ')).toContain('No hay cartera que reportar');
  });
});
