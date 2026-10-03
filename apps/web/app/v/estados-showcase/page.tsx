import { EXPENSE_CLASS_LABEL } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { StatementsFixture } from './Showcase';
import { CLASS_KEYS, LINES, fixtureStatements } from './fixture';

/**
 * ESTADOS FINANCIEROS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /estados pide sesión; aquí se pinta la misma pantalla con 24 meses
 * inventados y los cálculos de verdad. Parámetros: `?contable=1` (con el
 * estado de resultados de Siigo al lado), `?modo=oscuro`.
 */
export const dynamic = 'force-dynamic';

export default async function EstadosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const data = fixtureStatements({ contable: one('contable') === '1' });
  return (
    <StatementsFixture
      dark={one('modo') === 'oscuro'}
      data={data}
      lines={LINES}
      classLabels={{ ...EXPENSE_CLASS_LABEL }}
      classKeys={CLASS_KEYS}
      providerLabel={data.accounting.provider ? 'Siigo' : null}
      canEdit
      links={{
        self: '/v/estados-showcase',
        budget: '/v/presupuesto-showcase',
        board: '/v/informe-socios-showcase',
        finance: '#',
        integrations: '#',
        chat: '#',
      }}
    />
  );
}
