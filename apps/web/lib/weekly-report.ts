import 'server-only';
import { buildPeopleLoad } from '@/app/(app)/commitments/_lib/people';
import { sendEmail } from '@/lib/email';
import { renderWeeklyReportEmail } from '@/lib/email-templates';
import { noteWeeklyReportUndelivered } from '@/lib/notifications/producers';
import { mustReadList } from '@/lib/supabase/read';
import {
  PREFERENCE_COLUMNS,
  type ReportDocument,
  addDays,
  bogotaToday,
  buildWeekly,
  claimWeeklyReport,
  mondayOf,
  rowToPreferences,
  weekSpan,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * EL PARTE SEMANAL: construirlo, reclamar la semana, y sólo entonces mandarlo.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO VIVE DENTRO DE LA FUNCIÓN DE INNGEST
 * ===========================================================================
 * Porque hay que poder probar lo único que de verdad importa aquí — que
 * ejecutarlo dos veces sobre la misma semana produce UN informe y UN correo — y
 * una función de Inngest no se puede llamar desde una prueba sin levantar medio
 * entorno. Así que la función de allá es una cáscara con pasos y ésta es el
 * trabajo, con el envío inyectado para que una prueba pueda contarlo.
 *
 * ===========================================================================
 * EL ORDEN, QUE ES TODO EL DISEÑO
 * ===========================================================================
 *   1. construir el documento     (lecturas, ninguna escritura)
 *   2. RECLAMAR la semana         (una inserción; la base decide si es nuestra)
 *   3. si y sólo si ganamos, mandar el correo
 *   4. si el correo falla, un aviso en la campana — y sólo entonces
 *
 * Reclamar antes de enviar y no al revés, porque los dos fallos no cuestan lo
 * mismo. Reclamar y no poder enviar deja el parte guardado en /reports y un
 * aviso diciendo que el correo no salió: la información existe y se puede ir a
 * buscar. Enviar y no poder reclamar manda el mismo parte en cada reintento de
 * Inngest, y un informe que llega dos veces enseña a ignorar a Cortex — la
 * primera vez que alguien recibe el mismo parte duplicado deja de leer los dos.
 *
 * Quién decide si ya se mandó NO es este archivo: es el índice único parcial
 * `reports_period_once_idx` de la migración 0100. Este código inserta y acepta
 * la respuesta, exactamente como `commitments-watch.ts` reclama un aviso.
 *
 * ===========================================================================
 * EL AGRUPADO POR PERSONA SE REUTILIZA, NO SE REESCRIBE
 * ===========================================================================
 * `buildPeopleLoad` es el que ya usa la pantalla de compromisos: promesas y
 * papeles nunca se suman, lo que no tiene dueño va al final, el orden es por
 * atrasos. Se le pasa al constructor como argumento porque un paquete no puede
 * importar de una aplicación — y porque la alternativa (una segunda
 * implementación en el paquete) haría que la pantalla y el correo del lunes
 * pudieran contestar distinto a la misma pregunta.
 *
 * CERO LLAMADAS AL MODELO en todo el recorrido. El documento sale de consultas
 * y el correo de plantillas.
 */

/** Quién recibe el parte, ya resuelto contra su preferencia. */
export interface WeeklyRecipient {
  userId: string;
  email: string;
}

export interface WeeklyMailer {
  (opts: { to: string; subject: string; text: string; html: string }): Promise<{
    sent: boolean;
    reason?: string;
  }>;
}

export interface RunWeeklyReportInput {
  /** Handle con alcance de espacio de trabajo. */
  db: SupabaseClient;
  /** Hoy en Bogotá. Inyectable para que la prueba no dependa del calendario. */
  today?: string;
  now?: Date;
  /** El lunes de la semana que se reporta. Por defecto, la que acaba de cerrar. */
  weekStart?: string;
  /** Inyectado para poder contarlo en una prueba. Por defecto, el de verdad. */
  sendMail?: WeeklyMailer;
}

export interface RunWeeklyReportResult {
  weekStart: string;
  /** Falso cuando otra corrida ya tenía esta semana. Nada más pasó. */
  claimed: boolean;
  reportId: string | null;
  recipients: number;
  delivered: number;
  failed: number;
}

/**
 * Las cifras y los titulares que van al correo, sacados del documento ya
 * resuelto y nunca recalculados.
 *
 * Es la regla de `store.ts` una capa más arriba: si el correo hiciera su propia
 * aritmética, el informe y el mensaje podrían decir números distintos y no
 * habría forma de saber cuál miente. Aquí sólo se leen `display` y `sub`, que el
 * constructor ya escribió.
 */
export function summarizeForEmail(doc: ReportDocument): {
  lede: string;
  figures: Array<{ label: string; display: string; sub: string | null }>;
  headlines: string[];
} {
  const prose = doc.sections.find((s) => s.type === 'prose');
  const lede =
    prose && prose.type === 'prose' ? (prose.paragraphs[0] ?? doc.subtitle ?? '') : (doc.subtitle ?? '');

  const metrics = doc.sections.find((s) => s.type === 'metrics');
  const figures =
    metrics && metrics.type === 'metrics'
      ? metrics.items.map((m) => ({
          label: m.label,
          display: m.figure.display,
          sub: m.sub,
        }))
      : [];

  // Un titular es una cifra que el propio informe pintó de rojo o de ámbar y
  // que no es cero. El tono lo decidió el constructor; aquí sólo se lee.
  const headlines =
    metrics && metrics.type === 'metrics'
      ? metrics.items
          .filter((m) => (m.tone === 'rose' || m.tone === 'amber') && (m.figure.raw ?? 0) > 0)
          .map((m) => `${m.label}: ${m.figure.display}`)
      : [];

  return { lede, figures, headlines };
}

/**
 * El parte, como mensaje de Cortex. El correo ya se mandó; esto es para
 * cuando abren el chat el lunes y alguien ya habló.
 */
export function letterForChat(input: {
  lede: string;
  headlines: string[];
  reportId: string;
}): string {
  const lines = [input.lede.trim()].filter(Boolean);
  if (input.headlines.length > 0) lines.push(input.headlines.slice(0, 3).join('\n'));
  lines.push(`El parte completo está en /reports/${input.reportId}.`);
  return lines.join('\n\n');
}

/**
 * Deja el parte en el hilo de esa persona. Best-effort: si no hay agente o
 * la inserción falla, el correo ya viajó y no se inventa una quinta bandeja.
 */
async function postWeeklyLetter(
  db: SupabaseClient,
  opts: { userId: string; weekStart: string; title: string; content: string },
): Promise<void> {
  const { data: agent } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  const agentId = (agent as { id?: string } | null)?.id;
  if (!agentId) return;

  const key = `weekly:${opts.weekStart}:${opts.userId}`;
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('external_key', key)
    .maybeSingle();

  let conversationId = (existing as { id?: string } | null)?.id ?? null;
  if (!conversationId) {
    const { data: created, error } = await db
      .from('conversations')
      .insert({
        user_id: opts.userId,
        agent_id: agentId,
        surface: 'web',
        title: opts.title.slice(0, 60),
        external_key: key,
      })
      .select('id')
      .single();
    if (error || !created) return;
    conversationId = (created as { id: string }).id;
  }

  await db.from('messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content: opts.content,
  });
}

/**
 * Quién responde por la empresa cuando nadie más responde.
 *
 * `users.role = 'org_admin'`, sin inventar un organigrama: el producto ya tomó
 * esa decisión y la aplica el escalamiento de compromisos (`orgAdmins()` en
 * inngest/functions/commitments-watch.ts). Una jerarquía nueva para esto sería
 * una tabla que nadie mantiene y que estaría mal el día que alguien cambia de
 * puesto.
 */
export async function weeklyRecipients(db: SupabaseClient): Promise<WeeklyRecipient[]> {
  const admins = mustReadList(
    await db.from('users').select('id, email').eq('role', 'org_admin').limit(20),
    'los administradores de este espacio de trabajo',
  ) as Array<{ id: string; email: string | null }>;
  if (admins.length === 0) return [];

  const prefs = mustReadList(
    await db
      .from('user_preferences')
      .select(PREFERENCE_COLUMNS)
      .in(
        'user_id',
        admins.map((a) => a.id),
      ),
    'las preferencias de aviso',
  ) as Array<Record<string, unknown>>;
  const byUser = new Map(prefs.map((p) => [String(p.user_id), p]));

  return admins
    .filter((a) => {
      // Sin fila de preferencias significa «nunca ha tocado los ajustes», y para
      // ESTA preferencia eso es que sí — al contrario que para el digest. Ver la
      // 0100 sección 4.
      const pref = rowToPreferences(a.id, byUser.get(a.id) ?? null);
      return pref.weeklyReportEnabled;
    })
    .filter((a): a is { id: string; email: string } => Boolean(a.email?.trim()))
    .map((a) => ({ userId: a.id, email: a.email.trim() }));
}

export async function runWeeklyReport(
  input: RunWeeklyReportInput,
): Promise<RunWeeklyReportResult> {
  const { db } = input;
  const now = input.now ?? new Date();
  const today = input.today ?? bogotaToday(now);
  const weekStart = input.weekStart ?? addDays(mondayOf(today), -7);
  const sendMail: WeeklyMailer = input.sendMail ?? ((opts) => sendEmail(opts));

  // 1. El documento. Sólo lecturas: si algo falla aquí no se ha escrito nada y
  //    la semana sigue libre para el reintento.
  const document = await buildWeekly({
    db,
    today,
    now,
    weekStart,
    groupByPerson: buildPeopleLoad,
  });

  // 2. La reclamación. A partir de esta línea la semana es nuestra o no lo es,
  //    y la base es quien lo dice.
  const claim = await claimWeeklyReport(db, { document, periodStart: weekStart });
  if (!claim.claimed) {
    return {
      weekStart,
      claimed: false,
      reportId: null,
      recipients: 0,
      delivered: 0,
      failed: 0,
    };
  }

  const row = claim.row;
  const recipients = await weeklyRecipients(db);
  const summary = summarizeForEmail(document);
  const letter = letterForChat({
    lede: summary.lede,
    headlines: summary.headlines,
    reportId: row.id,
  });
  const mail = renderWeeklyReportEmail({
    reportId: row.id,
    title: document.title,
    periodLabel: document.periodLabel,
    weekLabel: weekSpan(weekStart, addDays(weekStart, 6)),
    lede: summary.lede,
    figures: summary.figures,
    headlines: summary.headlines,
    notes: document.notes,
    sourceCount: document.sources.length,
  });

  let delivered = 0;
  let failed = 0;
  for (const person of recipients) {
    await postWeeklyLetter(db, {
      userId: person.userId,
      weekStart,
      title: document.title,
      content: letter,
    }).then(undefined, () => undefined);
    const outcome = await sendMail({
      to: person.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (outcome.sent) {
      delivered += 1;
      continue;
    }
    failed += 1;
    // SÓLO AQUÍ. La 0096 dice que un aviso no repite lo que ya viajó por un
    // canal que la persona mira; si el correo llegó, la campana se calla.
    await noteWeeklyReportUndelivered(db, {
      userId: person.userId,
      reportId: row.id,
      periodLabel: document.periodLabel,
      reason: outcome.reason ?? null,
    });
  }

  return {
    weekStart,
    claimed: true,
    reportId: row.id,
    recipients: recipients.length,
    delivered,
    failed,
  };
}
