import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * LOS DATOS QUE LOS CINCO PANELES ENSEÑAN.
 *
 * ===========================================================================
 * POR QUÉ SIEMBRA LA PRUEBA Y NO UN GUION APARTE
 * ===========================================================================
 * Un panel vacío y un panel roto se ven igual y significan lo contrario, así
 * que una prueba que sólo comprueba que el marco aparece no prueba nada: el
 * marco aparece igual cuando la herramienta devuelve cero filas. Estas pruebas
 * afirman cifras y frases concretas —«69.850.000», «póliza», «SECOP»— y para
 * eso los datos tienen que ser suyos.
 *
 * Y tienen que sembrarse EN CADA VUELTA, no una vez a mano: la base local se
 * reinicia con cada migración que alguien prueba, y una suite que depende de
 * que nadie la haya tocado desde ayer es una suite que falla por motivos que no
 * tienen nada que ver con lo que vigila.
 *
 * ===========================================================================
 * LA ORGANIZACIÓN SE BUSCA, NO SE ESCRIBE
 * ===========================================================================
 * `requireSession()` aprovisiona un espacio de trabajo la primera vez que la
 * cuenta entra, así que su id es distinto cada vez que la cuenta se recrea.
 * Escribirlo aquí sería sembrar en el espacio de ayer y mirar el de hoy.
 *
 * Se escribe con SQL directo y no con las herramientas del agente a propósito:
 * lo que se está probando es el panel, y una siembra que pasara por
 * `payments.record` haría que un fallo en esa herramienta se leyera como un
 * fallo del panel.
 */

/** `.env.local` sin dependencias nuevas: Playwright no lo carga solo. */
function env(key: string): string {
  const file = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of file.split('\n')) {
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  throw new Error(`falta ${key} en apps/web/.env.local`);
}

/**
 * El id que un `insert … returning id` acaba de devolver.
 *
 * `noUncheckedIndexedAccess` tiene razón en que `rows[0]` puede no existir, y
 * aquí no puede no existir de verdad: un insert que no devuelve fila es un
 * fallo del sembrado, no un caso a contemplar. Se levanta diciendo QUÉ no se
 * pudo crear, que es lo único que sirve a las siete de la mañana; un `!` a secas
 * dejaría un `undefined` viajando hasta la primera consulta que lo use, y el
 * síntoma aparecería tres tablas más allá.
 */
function returnedId(result: { rows: Array<{ id: string }> }, what: string): string {
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`el sembrado no pudo crear ${what}`);
  return id;
}

/** El día del calendario de Bogotá, desplazado. Las cifras dependen de esto. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function seedPanelData(email: string): Promise<void> {
  const client = new pg.Client({ connectionString: env('SUPABASE_DB_URL') });
  await client.connect();
  try {
    const who = await client.query<{ id: string; organization_id: string }>(
      'select id, organization_id from users where email = $1 limit 1',
      [email],
    );
    const user = who.rows[0];
    if (!user) throw new Error(`${email} no tiene fila de directorio: ¿entró alguna vez?`);
    const org = user.organization_id;

    const agent = await client.query<{ id: string }>(
      "select id from agents where organization_id = $1 and slug = 'cortex' limit 1",
      [org],
    );
    const agentId = agent.rows[0]?.id;
    if (!agentId) throw new Error('el espacio de trabajo no tiene agente cortex');

    // Idempotente: la suite se corre muchas veces sobre la misma cuenta.
    for (const table of [
      'payments',
      'document_extractions',
      'kb_documents',
      'commitments',
      'errands',
      'reports',
      'mcp_pending_actions',
      'clients',
    ]) {
      await client.query(`delete from ${table} where organization_id = $1`, [org]);
    }

    // ---------------------------------------------------------------- clientes
    const clientIds: string[] = [];
    for (const [name, nit] of [
      ['Andina Logística S.A.S.', '900123456'],
      ['Transportes del Caribe Ltda.', '901987654'],
      ['Café de Origen S.A.', '830445566'],
    ]) {
      const row = await client.query<{ id: string }>(
        `insert into clients (organization_id, name, tax_id, status, city, payment_terms_days)
         values ($1, $2, $3, 'active', 'Bogotá', 30) returning id`,
        [org, name, nit],
      );
      clientIds.push(returnedId(row, `el cliente ${name}`));
    }

    // --------------------------------------------------------- cartera abierta
    // `payments.receivables` suma facturas CONFIRMADAS y les resta lo abonado.
    // 89,85 facturado − 20 abonados = 69,85 abiertos, con una sola vencida.
    const collection = await client.query<{ id: string }>(
      'select id from kb_collections where organization_id = $1 limit 1',
      [org],
    );
    const collectionId =
      collection.rows[0]?.id ??
      returnedId(
        await client.query<{ id: string }>(
          `insert into kb_collections (organization_id, name, scope, created_by)
           values ($1, 'Facturas', 'global', $2) returning id`,
          [org, user.id],
        ),
        'el espacio de Facturas',
      );

    const extractionIds: string[] = [];
    const invoices: Array<[number, string, number, string, string]> = [
      [0, 'FV-2201', 48_500_000, day(-45), day(-15)],
      [1, 'FV-2214', 12_300_000, day(-30), day(0)],
      [2, 'FV-2230', 7_950_000, day(-12), day(18)],
      [0, 'FV-2241', 21_100_000, day(-6), day(24)],
    ];
    for (const [which, number, amount, issued, due] of invoices) {
      const doc = await client.query<{ id: string }>(
        `insert into kb_documents (collection_id, source, title, mime, sha256, organization_id, status)
         values ($1, 'upload', $2, 'application/pdf', $3, $4, 'ready') returning id`,
        [collectionId, `Factura ${number}`, createHash('sha256').update(number).digest('hex'), org],
      );
      const extraction = await client.query<{ id: string }>(
        `insert into document_extractions
           (organization_id, document_id, doc_type, classification_quote, client_id,
            client_match_state, review_state, confirmed_at, confirmed_by, doc_number,
            total_amount, currency, issued_on, due_on)
         values ($1, $2, 'invoice', 'FACTURA DE VENTA', $3, 'matched', 'confirmed', now(), $4,
                 $5, $6, 'COP', $7, $8)
         returning id`,
        [
          org,
          returnedId(doc, `la factura ${number}`),
          clientIds[which],
          user.id,
          number,
          amount,
          issued,
          due,
        ],
      );
      extractionIds.push(returnedId(extraction, `los datos extraídos de ${number}`));
    }

    await client.query(
      `insert into payments
         (organization_id, kind, amount, currency, paid_on, client_id, client_match_state,
          extraction_id, state, invoice_number)
       values ($1, 'payment', 20000000, 'COP', $2, $3, 'matched', $4, 'confirmed', 'FV-2201')`,
      [org, day(-20), clientIds[0], extractionIds[0]],
    );

    // ------------------------------------------------------------ vencimientos
    const commitments: Array<[string, string, string, number | null]> = [
      ['Renovar la póliza de responsabilidad civil', day(-4), 'Seguros Bolívar', 8_400_000],
      ['Pagar la retención en la fuente de julio', day(2), 'DIAN', 15_200_000],
      ['Entregar el informe de operación a Andina', day(9), 'Andina Logística S.A.S.', null],
      ['Revisar el contrato del Caribe', day(21), 'Transportes del Caribe Ltda.', null],
    ];
    for (const [title, due, counterparty, amount] of commitments) {
      await client.query(
        `insert into commitments
           (organization_id, title, due_on, counterparty, amount_cop, state, source_kind,
            source_user_id, review_state, owner_user_id, created_by)
         values ($1, $2, $3, $4, $5, 'in_force', 'manual', $6, 'confirmed', $6, $6)`,
        [org, title, due, counterparty, amount, user.id],
      );
    }

    // ---------------------------------------------------------------- encargos
    const errands: Array<
      [string, string, string, string, string | null, string | null, number | null]
    > = [
      [
        'monitor_change',
        'Avísame si Andina publica una licitación nueva en el SECOP',
        'watching',
        'Vigilando el SECOP por licitaciones de Andina.',
        null,
        null,
        60,
      ],
      [
        'research_compare',
        '¿Qué tarifas cobra la competencia en la ruta Bogotá–Barranquilla?',
        'delivered',
        'Tres competidores revisados.',
        'La banda va de 2,8 a 3,4 millones por tracto.',
        'Entregado con tres fuentes.',
        null,
      ],
      [
        'gather_sources',
        'Reúne los pliegos de la licitación de Cartagena',
        'working',
        'Buscando los pliegos publicados.',
        null,
        null,
        null,
      ],
    ];
    for (const [kind, request, state, brief, deliverable, closing, interval] of errands) {
      await client.query(
        `insert into errands
           (organization_id, user_id, kind, request, brief, state, token_ceiling, leg_ceiling,
            deliverable, closing_note, check_interval_minutes, started_at, finished_at)
         values ($1, $2, $3, $4, $5, $6, 200000, 6, $7, $8, $9, now() - interval '2 days', $10)`,
        [
          org,
          user.id,
          kind,
          request,
          brief,
          state,
          deliverable,
          closing,
          interval,
          closing ? new Date() : null,
        ],
      );
    }

    // ---------------------------------------------------------------- informes
    for (const [kind, title, period] of [
      ['weekly', 'Resumen semanal de operación', 'Semana del 10 al 16 de agosto'],
      ['client_activity', 'Actividad de Andina Logística', 'Julio 2026'],
      ['expiries', 'Vencimientos de la flota', 'Agosto 2026'],
    ]) {
      await client.query(
        `insert into reports
           (organization_id, kind, title, period_label, document, content_hash, generated_by, period_start)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          org,
          kind,
          title,
          period,
          JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Semilla de pruebas.' }] }),
          createHash('sha256').update(`${kind}-${period}`).digest('hex'),
          user.id,
          day(-30),
        ],
      );
    }

    // ------------------------------------------------------------ aprobaciones
    // La cola que el chat web NO llena: la escriben MCP, Google Chat y WhatsApp.
    // Por eso se siembra a mano — y por eso `approvals.list` existe.
    for (const [toolId, input] of [
      ['gmail.send_message', { to: 'contacto@andina.co', subject: 'Propuesta de renovación' }],
      ['payments.record', { amount: 8_400_000, currency: 'COP', client: 'Seguros Bolívar' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await client.query(
        `insert into mcp_pending_actions
           (organization_id, user_id, agent_id, tool_id, input, expires_at, staged_via)
         values ($1, $2, $3, $4, $5, now() + interval '20 hours', 'mcp')`,
        [org, user.id, agentId, toolId, JSON.stringify(input)],
      );
    }
  } finally {
    await client.end();
  }
}
