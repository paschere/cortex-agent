import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type MoneyRecovered,
  type RecoveredMovement,
  bogotaToday,
  moneyRecovered,
} from '@cortex/agent-tools';
import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { money, plural, shortDate } from './format';

/**
 * RECUPERADO CON CORTEX, CON SUS PRUEBAS (0166).
 *
 * La cifra de Inicio dice cuánto; esta sección dice de dónde sale, factura por
 * factura: qué pago, qué día, y después de qué acción de Cortex. Si alguien
 * duda de la cifra, aquí está cada peso con su enlace. Las reglas viven en
 * packages/agent-tools/src/payments/recovered.ts y se repiten al pie, enteras.
 *
 * Componente de servidor que se lee solo: la página sólo lo monta, y si la
 * lectura falla la sección no aparece en vez de tumbar Pagos.
 */

const MOVEMENT_LABEL: Record<RecoveredMovement['kind'], string> = {
  payment: 'Pago',
  reversal: 'Devolución',
  balance_drop: 'Bajó el saldo en el programa contable',
};

export async function RecoveredSection({ organizationId }: { organizationId: string }) {
  let recovered: MoneyRecovered;
  try {
    recovered = await moneyRecovered(getOrgScopedClient(organizationId), {
      today: bogotaToday(),
    });
  } catch {
    return null;
  }
  const { cop } = recovered;
  const manual = recovered.manual.filter((m) => m.counted > 0 || m.overlap > 0);
  const empty = recovered.items.length === 0 && manual.length === 0;

  return (
    <Panel id="recuperado" className="scroll-mt-24 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2.5 text-base font-bold text-ink-muted">
            <span className="grid h-9 w-9 place-items-center rounded-sm bg-emerald-soft text-emerald">
              <TrendingUp className="h-4 w-4" aria-hidden />
            </span>
            Recuperado con Cortex
          </h2>
          <p className="stat-num mt-3 text-2xl leading-none text-emerald sm:text-[2rem]">
            {money(cop.month, 'COP')}
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            este mes ·{' '}
            <span className="tabular font-mono font-semibold text-ink">
              {money(cop.total, 'COP')}
            </span>{' '}
            en total
          </p>
          {recovered.otherCurrencies.length > 0 && (
            <p className="mt-1 text-micro text-ink-faint">
              En otras monedas, aparte:{' '}
              {recovered.otherCurrencies.map((o) => money(o.total, o.currency)).join(', ')}.
            </p>
          )}
        </div>
        {!empty && (
          <div className="flex flex-wrap gap-2">
            <span className={chipClass('emerald')}>
              {plural(cop.invoices, 'factura')} con pagos atribuidos
            </span>
            {cop.manualCases > 0 && (
              <span className={chipClass('neutral')}>
                {plural(cop.manualCases, 'asunto')} con plata anotada
              </span>
            )}
          </div>
        )}
      </div>

      {empty ? (
        <p className="mt-4 text-sm text-ink-muted">
          Todavía no hay plata atribuible a Cortex. Aparece aquí cuando un pago llega después de un
          cobro enviado, un seguimiento de cobro en Gerencia o un aviso de mora, o cuando un
          administrador anota lo recuperado al cerrar un asunto.{' '}
          <Link href="/procesos" className="font-semibold text-primary hover:underline">
            Activar el cobro de cartera
          </Link>
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {recovered.items.map((it) => (
            <details
              key={it.invoiceId}
              className="group rounded-card border border-border bg-surface-2/40 px-3 py-2"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 truncate text-sm text-ink">
                  {it.counterparty ?? 'Cliente sin nombre'}
                  {it.docNumber ? <span className="text-ink-muted"> · {it.docNumber}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={chipClass('emerald')}>
                    {it.trigger.label} · {shortDate(it.trigger.on)}
                  </span>
                  <span className="tabular font-mono text-sm font-semibold text-ink">
                    {money(it.amount, it.currency)}
                  </span>
                </span>
              </summary>
              <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-ink-muted">
                {it.movements.map((m) => (
                  <li key={`${m.kind}:${m.id}`} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {MOVEMENT_LABEL[m.kind]} del {shortDate(m.on)}
                      {m.counted !== m.reported && m.kind !== 'reversal'
                        ? ` (decía ${money(m.reported, it.currency)}; cuenta hasta lo que se debía)`
                        : ''}{' '}
                      · tras{' '}
                      <Link href={m.trigger.href} className="font-semibold text-primary">
                        {m.trigger.label.toLowerCase()} del {shortDate(m.trigger.on)}
                      </Link>
                    </span>
                    <span className="tabular font-mono text-ink">
                      {money(m.counted, it.currency)}
                    </span>
                  </li>
                ))}
                {it.href && (
                  <li>
                    <a
                      href={it.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-primary"
                    >
                      Ver la factura en {it.system ?? 'el programa contable'} ↗
                    </a>
                  </li>
                )}
              </ul>
            </details>
          ))}
          {manual.map((m) => (
            <div
              key={m.caseId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-card border border-border px-3 py-2"
            >
              <span className="min-w-0 text-sm text-ink">
                <Link href={m.href} className="font-semibold text-primary">
                  {m.title}
                </Link>
                <span className="text-ink-muted"> · {m.note}</span>
                {m.overlap > 0 && (
                  <span className="block text-micro text-ink-faint">
                    Se anotaron {money(m.amountCop, 'COP')}; {money(m.overlap, 'COP')} ya estaban
                    contados por los pagos de la factura del asunto.
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={chipClass('neutral')}>Anotado al cerrar · {shortDate(m.on)}</span>
                <span className="tabular font-mono text-sm font-semibold text-ink">
                  {money(m.counted, 'COP')}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-micro text-ink-faint">{recovered.rules}</p>
    </Panel>
  );
}
