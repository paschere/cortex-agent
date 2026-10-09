import type { SupabaseClient } from '@supabase/supabase-js';
import { type AutopilotItemRow, itemFingerprint } from '../autopilot/store';
import { daysBetween } from '../commitments/shape';
import { listCommitments } from '../commitments/store';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import { moneyAtRisk } from '../payments/risk';
import { toolErrorMessage } from '../tool-error';
import { listWorkItems } from '../work/store';
import type { BriefingAsk, BriefingCommitment, BriefingInput } from './build';

/**
 * LO QUE SE LEE PARA «TU DÍA»: UNA VEZ POR EMPRESA, NO UNA VEZ POR PERSONA.
 *
 * `loadBriefingData` hace las lecturas con el handle de la empresa, cada una
 * aislada (una fuente que no se pudo leer no tumba el resumen; queda nombrada en
 * `errors` y esa frase simplemente no sale). `briefingInputFor` arma, sin base,
 * lo que le toca a cada persona: el dueño y los administradores ven la empresa;
 * los demás, sólo lo suyo.
 */

const OPEN_ASK_WINDOW_DAYS = 8;
const ANOMALY_WINDOW_HOURS = 36;

export interface BriefingPerson {
  id: string;
  name: string;
  email: string;
}

interface CommitmentLite extends BriefingCommitment {
  ownerUserId: string | null;
}

export interface BriefingData {
  today: string;
  people: BriefingPerson[];
  commitments: CommitmentLite[] | undefined;
  workOverdue: Array<{ title: string; assigneeId: string | null; daysOverdue: number }> | undefined;
  receivables: BriefingInput['receivables'] | undefined;
  asks: BriefingAsk[] | undefined;
  anomalies: BriefingAsk[] | undefined;
  errors: Array<{ source: string; message: string }>;
}

function toAsk(r: AutopilotItemRow): BriefingAsk {
  return {
    itemId: r.id,
    contentHash: itemFingerprint(r),
    title: r.title,
    why: r.why,
    // Aprobable con un clic sólo si hay herramienta y NO es un correo a un
    // cliente (ésos se aprueban en Aprobaciones, donde se ve el texto exacto).
    actionable: Boolean(r.tool_id) && !r.action_id && r.effect !== 'external_message',
  };
}

export async function loadBriefingData(
  db: SupabaseClient,
  opts: { today: string; now: Date },
): Promise<BriefingData> {
  const { today, now } = opts;
  const errors: BriefingData['errors'] = [];
  const attempt = async <T>(source: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ source, message: toolErrorMessage(err) });
      return undefined;
    }
  };

  const [directory, commitments, work, risk, items] = await Promise.all([
    attempt('directorio', () => listDirectory(db)),
    attempt('compromisos', () =>
      listCommitments(db, { states: ['overdue', 'due_soon'], today, dueBefore: today, limit: 300 }),
    ),
    attempt('trabajo', () => listWorkItems(db, { status: 'open', limit: 5000 })),
    attempt('cartera', () => moneyAtRisk(db, { today })),
    attempt('piloto', async () => {
      const since = new Date(now.getTime() - OPEN_ASK_WINDOW_DAYS * 86_400_000).toISOString();
      const { data, error } = await db
        .from('autopilot_items')
        .select(
          'id, run_id, dedupe_key, area, title, why, risk, effect, decision, decision_reason, authority, mandate_id, tool_id, tool_input, amount, currency, counterparty, href, undo, status, result_summary, verification, verification_detail, error, action_id, decided_by, decided_at, executed_at, created_at, updated_at',
        )
        .in('status', ['asked', 'told'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as AutopilotItemRow[];
    }),
  ]);

  const names = new Map((directory ?? []).map((p) => [p.id, personLabel(p)]));
  const anomalyCutoff = now.getTime() - ANOMALY_WINDOW_HOURS * 3_600_000;
  const anomalyRows = (items ?? []).filter(
    (r) => r.dedupe_key.startsWith('anomalia:') && Date.parse(r.created_at) >= anomalyCutoff,
  );
  const askRows = (items ?? []).filter(
    (r) => r.status === 'asked' && !r.dedupe_key.startsWith('anomalia:'),
  );

  return {
    today,
    people: (directory ?? []).map((p) => ({
      id: p.id,
      name: personLabel(p),
      email: p.email,
    })),
    commitments: commitments?.map((c) => ({
      title: c.title,
      dueOn: c.due_on,
      counterparty: c.counterparty,
      ownerName: c.owner_user_id ? (names.get(c.owner_user_id) ?? null) : null,
      ownerUserId: c.owner_user_id,
    })),
    workOverdue: work?.items
      .filter((w) => w.dueAt && w.dueAt.slice(0, 10) < today)
      .map((w) => ({
        title: w.title,
        assigneeId: w.assigneeId,
        daysOverdue: Math.max(1, daysBetween((w.dueAt as string).slice(0, 10), today)),
      })),
    receivables: risk
      ? {
          overdueAmount: risk.cop.receivablesOverdue,
          invoices: risk.cop.overdueInvoices,
          top: risk.topInvoices[0]
            ? {
                who: risk.topInvoices[0].counterparty,
                amount: risk.topInvoices[0].balance,
                daysOverdue: risk.topInvoices[0].daysOverdue,
              }
            : null,
        }
      : undefined,
    asks: items ? askRows.map(toAsk) : undefined,
    anomalies: items ? anomalyRows.map(toAsk) : undefined,
    errors,
  };
}

/** Lo que le toca a una persona: la empresa si administra, lo suyo si no. */
export function briefingInputFor(
  data: BriefingData,
  person: { id: string; name: string },
  isManager: boolean,
): BriefingInput {
  const mine = <T extends { ownerUserId: string | null }>(rows: T[]) =>
    isManager ? rows : rows.filter((r) => r.ownerUserId === person.id);
  const commitments = mine(data.commitments ?? []);
  return {
    today: data.today,
    firstName: person.name.trim().split(/\s+/)[0] || null,
    scope: isManager ? 'company' : 'person',
    overdueCommitments: commitments.filter((c) => c.dueOn < data.today),
    dueTodayCommitments: commitments.filter((c) => c.dueOn === data.today),
    workOverdue: (data.workOverdue ?? [])
      .filter((w) => w.assigneeId === person.id)
      .map(({ title, daysOverdue }) => ({ title, daysOverdue })),
    receivables: isManager ? data.receivables : undefined,
    asks: isManager ? (data.asks ?? []) : [],
    anomalies: isManager ? (data.anomalies ?? []) : [],
  };
}
