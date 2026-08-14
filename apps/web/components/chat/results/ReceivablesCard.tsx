'use client';

import { money, plural, shortDate } from '@/app/(app)/payments/_components/format';
import { chipClass } from '@/lib/status-chip';
import { Banknote } from 'lucide-react';
import type { ResultViewProps } from './registry';

/**
 * «¿CUÁNTO NOS DEBEN?», CON LA CONFESIÓN PEGADA A LA CIFRA.
 *
 * ===========================================================================
 * LAS DOS COSAS QUE ESTA TARJETA NO PUEDE HACER
 * ===========================================================================
 * NO SUMA. Ni una cifra de aquí se calcula en el navegador: `payments.receivables`
 * ya resolvió la cartera, moneda por moneda, contra las facturas que una persona
 * confirmó. Un componente de cliente que sumara dinero sería un segundo sitio
 * donde el dinero se suma, y dos sitios donde se suma dinero acaban dando dos
 * cifras. Es la misma postura que `PaymentsBoard` dejó escrita en su cabecera.
 *
 * NO MEZCLA MONEDAS, porque no puede: cada una es su propia fila y su propio
 * total. Sumar 3.000 USD a 12.000.000 COP produce 12.003.000 de nada.
 *
 * ===========================================================================
 * LA FRASE VA ENTERA, Y VA DEBAJO DEL NÚMERO
 * ===========================================================================
 * `guidance` dice sobre cuántas facturas confirmadas está hecha la cifra,
 * cuántas leídas siguen sin revisar y por tanto NO están en ella, y cuántos
 * pagos están en disputa y no restan de nada. Enseñar el número sin ella enseña
 * a leer un total incompleto como si fuera completo — y un total así se cita en
 * una reunión y nadie lo audita. Se muestra completa, nunca resumida.
 *
 * El importe se formatea con `money`, que es la misma función de la pantalla de
 * Pagos y la que impide que un valor salga sin su moneda pegada: en un producto
 * que maneja facturas de importación, un «$4.200.000» a secas se puede leer de
 * dos formas que difieren por un factor de cuatro mil.
 */

interface Currency {
  currency: string;
  outstanding: number;
  invoiced: number;
  paid: number;
  openInvoices: number;
  ageDays: number | null;
  overdue: number;
  overdueInvoices: number;
}

interface Receivables {
  today: string;
  byCurrency: Currency[];
  pendingExcluded: number;
  guidance: string;
}

export function ReceivablesCard({ result }: ResultViewProps) {
  const view = receivablesOf(result);
  if (!view) return null;

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Banknote className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Cartera</span>
        <span className="ml-auto text-micro text-ink-faint">al {shortDate(view.today)}</span>
      </div>

      {view.byCurrency.length === 0 ? (
        <p className="px-4 py-4 text-sm leading-relaxed text-ink-muted">
          {view.pendingExcluded > 0
            ? `Todavía no hay cartera que calcular. Hay ${plural(view.pendingExcluded, 'factura leída', 'facturas leídas')} que nadie ha confirmado, y ninguna entra en una cifra hasta que alguien las revise.`
            : 'No hay ninguna factura confirmada con saldo pendiente.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {view.byCurrency.map((c) => (
            <li
              key={c.currency}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-3"
            >
              <span className="stat-num text-lg font-semibold leading-none text-ink">
                {money(c.outstanding, c.currency)}
              </span>
              <span className="text-xs text-ink-muted">
                {c.ageDays != null ? `a ${plural(c.ageDays, 'día')}` : 'sin edad calculable'} ·{' '}
                {plural(c.openInvoices, 'factura abierta', 'facturas abiertas')}
              </span>
              {c.overdueInvoices > 0 && (
                <span className={chipClass('rose')}>
                  {money(c.overdue, c.currency)} vencido en {plural(c.overdueInvoices, 'factura')}
                </span>
              )}
              <span className="tabular ml-auto text-micro text-ink-faint">
                facturado {money(c.invoiced, c.currency)} · abonado {money(c.paid, c.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border bg-surface-2 px-4 py-2.5 text-xs leading-relaxed text-ink-muted">
        {view.guidance}
      </p>
    </div>
  );
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Sin `guidance` no se dibuja NADA: la cifra sin la confesión es el único
 * resultado que esta tarjeta no tiene derecho a enseñar.
 */
function receivablesOf(result: unknown): Receivables | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.today !== 'string' || typeof r.guidance !== 'string' || !r.guidance.trim()) {
    return null;
  }
  const list = Array.isArray(r.byCurrency) ? r.byCurrency : [];
  const byCurrency = list.filter(
    (row): row is Currency =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as Currency).currency === 'string' &&
      typeof (row as Currency).outstanding === 'number',
  );
  return {
    today: r.today,
    byCurrency,
    pendingExcluded: typeof r.pendingExcluded === 'number' ? r.pendingExcluded : 0,
    guidance: r.guidance,
  };
}
