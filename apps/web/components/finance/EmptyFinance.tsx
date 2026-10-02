import { Panel } from '@/components/ui/panel';
import { chatHref } from '@/lib/finance/dashboard-shape';
import { CalendarRange, FileUp, Landmark, MessageSquareText, Plug, Wallet } from 'lucide-react';
import Link from 'next/link';
import { pillLink, pillPrimary } from './pieces';
import type { FinanceLinks } from './types';

/**
 * LA EMPRESA QUE TODAVÍA NO TIENE NADA EN EL LIBRO: una sola tarjeta que dice
 * qué va a haber aquí y las tres formas de llenarlo. Nada de secciones vacías
 * con «sin dato» que parecen rotas.
 */
export function EmptyFinance({ links }: { links: FinanceLinks }) {
  const promises = [
    { icon: Wallet, text: 'Cuánta plata hay hoy, cuenta por cuenta.' },
    {
      icon: CalendarRange,
      text: 'Si te alcanza las próximas 13 semanas, y qué semana se aprieta.',
    },
    { icon: Landmark, text: 'Cómo va el mes: ventas, gastos, margen y en qué se va la plata.' },
  ];
  return (
    <Panel className="overflow-hidden">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="p-6 sm:p-8">
          <h2 className="text-xl font-extrabold text-ink">Tus finanzas, en una sola pantalla</h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
            Cuando Cortex tenga tus movimientos, aquí vas a ver tu caja, la proyección de las
            próximas semanas y los resultados de cada mes. Cada cifra dice de dónde salió.
          </p>
          <ul className="mt-5 space-y-3">
            {promises.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-ink">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="pt-1.5">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-border bg-surface-2/60 p-6 sm:p-8 lg:border-l lg:border-t-0">
          <h3 className="text-base font-bold text-ink">Empieza por cualquiera</h3>
          <ol className="mt-4 space-y-4">
            <li>
              <p className="text-sm text-ink-muted">
                Conecta tu programa contable (Siigo, Alegra, QuickBooks) y trae todo de una vez.
              </p>
              <Link href={links.accounting} className={`${pillPrimary} mt-2`}>
                <Plug className="h-3.5 w-3.5" aria-hidden />
                Conectar programa contable
              </Link>
            </li>
            <li>
              <p className="text-sm text-ink-muted">
                O sube el extracto de tu banco en Excel o CSV: saldo y movimientos.
              </p>
              <Link href={links.bankImport} className={`${pillLink} mt-2`}>
                <FileUp className="h-3.5 w-3.5" aria-hidden />
                Subir extracto
              </Link>
            </li>
            <li>
              <p className="text-sm text-ink-muted">
                O cuéntaselo a Cortex: «hoy hay 48 millones en Bancolombia», «pago 6,5 millones de
                arriendo el 5».
              </p>
              <Link
                href={chatHref(
                  links.chat,
                  'Quiero empezar a llevar mis finanzas en Cortex. Pregúntame lo que necesites: saldos de mis cuentas, gastos fijos y lo que me deben.',
                )}
                className={`${pillLink} mt-2`}
              >
                <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
                Registrar hablando con Cortex
              </Link>
            </li>
          </ol>
        </div>
      </div>
    </Panel>
  );
}
