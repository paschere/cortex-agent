import type { SupabaseClient } from '@supabase/supabase-js';
import { budgetVsActual } from '../budget/shape';
import { activeBudget, budgetCells, getBudget } from '../budget/store';
import { addDays } from '../commitments/shape';
import { listCommitments } from '../commitments/store';
import { hasLedgerCash } from '../ledger/forecast-explain';
import { monthlyPnl, runForecast } from '../ledger/plans';
import { maskPayrollForecast } from '../ledger/privacy';
import { readOperationEvents, readOperations } from '../management/operation-store';
import { readWeeklyManagement } from '../management/weekly-review';
import { loadStatements, monthEnd } from '../statements/store';
import { type BoardInput, composeBoard } from './compose';
import {
  type BoardContent,
  type BoardReport,
  PERIOD_RE,
  boardMarkdown,
  periodLabel,
} from './shape';
import { saveBoardReport } from './store';
import { type BoardWriter, writeBoardSummary } from './writer';

/**
 * ARMAR EL INFORME DE UN MES (0191).
 *
 * Lee todo con el handle del espacio y SIN persona que mire (`viewerId: null`):
 * el informe va a socios, así que la nómina sale siempre como un solo total
 * confidencial (ledger/privacy.ts), aunque lo arme quien administra. Cada
 * lectura aislada: lo que falla queda en `gaps` y en el informe, nunca como
 * un cero.
 */

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

async function companyName(db: SupabaseClient, organizationId: string | null): Promise<string> {
  const { data, error } = await db.from('company_branding').select('display_name').maybeSingle();
  const display = error
    ? null
    : (data as { display_name?: string | null } | null)?.display_name?.trim();
  if (display) return display;
  if (!organizationId) return 'La empresa';
  const org = await db
    .from('ba_organization')
    .select('name')
    .eq('id', organizationId)
    .maybeSingle();
  return (org.error ? null : (org.data as { name?: string } | null)?.name?.trim()) || 'La empresa';
}

export async function gatherBoardInput(
  db: SupabaseClient,
  opts: { period: string; today: string; organizationId: string | null; budgetId?: string | null },
): Promise<BoardInput & { companyName: string }> {
  const gaps: string[] = [];
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingTable(err)) gaps.push(label);
      return null;
    }
  };
  const year = Number(opts.period.slice(0, 4));
  const month = Number(opts.period.slice(5, 7));
  const periodEnd = monthEnd(year, month);
  const cutoff = periodEnd < opts.today ? periodEnd : opts.today;
  const periodStart = `${opts.period}-01`;
  const nextStart = addDays(periodEnd, 1);

  const [company, statements, budget, forecast, closures, decisions, obligations] =
    await Promise.all([
      companyName(db, opts.organizationId),
      attempt('los estados financieros', () =>
        loadStatements(db, { today: opts.today, viewerId: null, year, throughMonth: month }),
      ),
      attempt('el presupuesto', async () => {
        const b = opts.budgetId ? await getBudget(db, opts.budgetId) : await activeBudget(db, year);
        if (!b) return null;
        const months =
          Number(cutoff.slice(0, 4)) * 12 + Number(cutoff.slice(5, 7)) - (year * 12 + 1) + 1;
        const [cells, history] = await Promise.all([
          budgetCells(db, b.id),
          monthlyPnl(db, { months: Math.max(months, 1), today: cutoff, includePayroll: false }),
        ]);
        return {
          name: b.name,
          approved: b.status === 'aprobado',
          vs: budgetVsActual(cells, history, { year, today: cutoff }),
        };
      }),
      attempt('la proyección de caja', async () =>
        maskPayrollForecast((await runForecast(db, { today: opts.today })).base),
      ),
      attempt('los asuntos de Gerencia', () => readWeeklyManagement(db, periodStart, nextStart)),
      attempt('las decisiones de Gerencia', async () => {
        const ops = await readOperations(db);
        const out: Array<{ question: string; resolved: string | null }> = [];
        for (const op of ops.operations.slice(0, 3)) {
          const { events } = await readOperationEvents(db, op.id);
          for (const e of events) {
            const d = e.data;
            if (d.kind !== 'decision') continue;
            const resolve = events.find(
              (r) => r.data.kind === 'resolve' && r.data.decisionId === e.id,
            );
            const inMonth = e.created_at >= periodStart && e.created_at < nextStart;
            const resolvedInMonth =
              resolve && resolve.created_at >= periodStart && resolve.created_at < nextStart;
            if (!inMonth && !resolvedInMonth && resolve) continue;
            const option =
              resolve && resolve.data.kind === 'resolve'
                ? (d.decision.options[resolve.data.option]?.label ?? null)
                : null;
            out.push({
              question: d.decision.question.replace(/\s+/g, ' ').slice(0, 200),
              resolved: option,
            });
          }
        }
        return out;
      }),
      attempt('los vencimientos', () =>
        listCommitments(db, {
          states: ['due_soon', 'overdue', 'in_force'],
          today: opts.today,
          dueBefore: addDays(opts.today, 30),
          excludeKinds: ['internal'],
          limit: 100,
        }),
      ),
    ]);

  const cash =
    forecast && hasLedgerCash(forecast)
      ? {
          total: forecast.startingCash,
          asOf: forecast.asOf,
          lowestWeek: forecast.lowest?.week ?? null,
          lowestClosing: forecast.lowest?.closing ?? null,
          endClosing: forecast.weeks[forecast.weeks.length - 1]?.closing ?? null,
          weeks: forecast.weeks.length,
          alerts: forecast.alerts.map((a) => ({ severity: a.severity, message: a.message })),
        }
      : null;
  if (forecast && !cash) gaps.push('la caja (no hay saldos de banco en el libro)');

  return {
    companyName: company,
    period: opts.period,
    company,
    today: opts.today,
    income: statements?.income ?? null,
    budget,
    cash,
    working: {
      receivables: statements?.working.receivables ?? null,
      payables: statements?.working.payables ?? null,
    },
    indicators: statements?.indicators ?? null,
    balanceBasis: statements?.balance.basis ?? null,
    milestones: (closures?.closures ?? []).map((c) => ({
      title: String(c.data.title ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 180),
      evidence: c.data.evidence?.reference ?? null,
    })),
    decisions: decisions ?? [],
    obligations: (obligations ?? []).map((o) => ({
      title: o.title,
      dueOn: o.due_on,
      overdue: o.due_on < opts.today,
      amount: o.amount_cop ?? null,
    })),
    gaps: [...gaps, ...(statements?.gaps ?? [])],
  };
}

export async function generateBoardReport(
  db: SupabaseClient,
  opts: {
    period: string;
    today: string;
    userId: string | null;
    organizationId: string | null;
    write?: BoardWriter;
    now?: Date;
  },
): Promise<BoardReport> {
  if (!PERIOD_RE.test(opts.period)) throw new Error('El mes va como AAAA-MM.');
  const input = await gatherBoardInput(db, opts);
  const composed = composeBoard(input);
  const label = periodLabel(opts.period);
  const summary = await writeBoardSummary(
    {
      company: input.companyName,
      periodLabel: label,
      facts: composed.facts,
      sections: composed.sections,
      fallback: composed.fallbackSummary,
      now: opts.now,
    },
    opts.write,
  );
  const content: BoardContent = {
    version: 1,
    period: opts.period,
    periodLabel: label,
    company: input.companyName,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    summary: summary.lines,
    summarySource: summary.source,
    sections: composed.sections,
    facts: composed.facts,
    gaps: input.gaps,
  };
  return saveBoardReport(
    db,
    {
      period: opts.period,
      title: `Informe para socios — ${label}`,
      content,
      markdown: boardMarkdown(content),
      fallback: summary.source === 'plantilla',
    },
    { userId: opts.userId },
  );
}
