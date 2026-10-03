import { TODAY, fixtureHistory, fixtureStatements } from '@/app/v/estados-showcase/fixture';
import {
  type BoardContent,
  type BoardReport,
  DEFAULT_BOARD_SETTINGS,
  boardPeriodLabel,
  budgetFromActuals,
  budgetVsActual,
  composeBoard,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { BoardFixture } from './Showcase';

/**
 * INFORME PARA SOCIOS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * El informe de septiembre armado con `composeBoard` (el mismo del producto)
 * sobre los datos inventados de /v/estados-showcase. El resumen es el de la
 * plantilla (aquí no se llama al modelo). Parámetros: `?vista=lista`,
 * `?modo=oscuro`.
 */
export const dynamic = 'force-dynamic';

export default async function InformeShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
  const history = fixtureHistory();
  const s = fixtureStatements({ month: 9 });
  const cells = budgetFromActuals(history, { year: 2026, growthPct: 8, incomeGrowthPct: 12 }).map(
    (c) => (c.category === 'mercadeo' ? { ...c, amount: Math.round(c.amount * 0.7) } : c),
  );
  const composed = composeBoard({
    period: '2026-09',
    company: 'Transportes Andinos SAS',
    today: TODAY,
    income: s.income,
    budget: {
      name: 'Presupuesto 2026',
      approved: true,
      vs: budgetVsActual(cells, history, { year: 2026, today: '2026-09-30' }),
    },
    cash: {
      total: 168_900_000,
      asOf: TODAY,
      lowestWeek: '2026-11-02',
      lowestClosing: 41_200_000,
      endClosing: 122_000_000,
      weeks: 13,
      alerts: [
        {
          severity: 'warn',
          message:
            'La caja queda apretada la semana del 2 nov: entra la nómina y la prima antes del pago de Nexa.',
        },
      ],
    },
    working: { receivables: s.working.receivables, payables: s.working.payables },
    indicators: s.indicators,
    balanceBasis: 'aproximado',
    milestones: [
      {
        title: 'Renegociar el contrato de arriendo de la bodega de Funza',
        evidence: 'contrato-firmado.pdf',
      },
      { title: 'Cerrar la cartera vencida de Agroandes', evidence: 'recibo-caja-1043' },
    ],
    decisions: [
      { question: '¿Abrimos la ruta Bogotá–Bucaramanga en enero?', resolved: null },
      {
        question: '¿Renovamos dos camiones o los arrendamos?',
        resolved: 'Arrendarlos por 24 meses',
      },
    ],
    obligations: [
      {
        title: 'Declaración de retención en la fuente (septiembre)',
        dueOn: '2026-10-14',
        overdue: false,
        amount: null,
      },
      { title: 'SOAT del camión WGY482', dueOn: '2026-10-22', overdue: false, amount: 1_250_000 },
    ],
    gaps: [],
  });
  const content: BoardContent = {
    version: 1,
    period: '2026-09',
    periodLabel: boardPeriodLabel('2026-09'),
    company: 'Transportes Andinos SAS',
    generatedAt: '2026-10-05T12:00:00Z',
    summary: composed.fallbackSummary,
    summarySource: 'plantilla',
    sections: composed.sections,
    facts: composed.facts,
    gaps: [],
  };
  const report: BoardReport = {
    id: '00000000-0000-4000-8000-0000000000c1',
    period: '2026-09',
    status: 'borrador',
    title: 'Informe para socios — septiembre de 2026',
    content,
    markdown: '',
    fallback: true,
    generatedAt: '2026-10-05T12:00:00Z',
    generatedBy: null,
    visibility: 'contrasena',
    shareToken: 'A'.repeat(32),
    shareExpiresAt: null,
    shareViews: 3,
    sentAt: null,
    sentTo: [],
    updatedAt: '2026-10-05T12:00:00Z',
  };
  const older: BoardReport = {
    ...report,
    id: '00000000-0000-4000-8000-0000000000c2',
    period: '2026-08',
    status: 'enviado',
    content: { ...content, period: '2026-08', periodLabel: boardPeriodLabel('2026-08') },
    sentAt: '2026-09-06T14:00:00Z',
    sentTo: ['socia@andinos.co', 'junta@andinos.co'],
    visibility: 'enlace',
  };
  return (
    <BoardFixture
      dark={one('modo') === 'oscuro'}
      view={one('vista') === 'lista' ? 'lista' : 'detalle'}
      report={report}
      reports={[report, older]}
      settings={{
        ...DEFAULT_BOARD_SETTINGS,
        enabled: true,
        recipients: ['socia@andinos.co', 'junta@andinos.co'],
      }}
    />
  );
}
