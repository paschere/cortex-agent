import type { PaymentKind, PaymentState } from '@/lib/payments-shape';

/**
 * Lo que el servidor le entrega al navegador: conclusiones, nunca filas.
 *
 * Los nombres ya están resueltos, las fechas ya están escritas en es-CO y las
 * cifras ya están del lado correcto del signo. El componente de cliente no
 * decide nada de eso — es la misma postura de `clients/_components/types.ts`, y
 * aquí importa más que en ningún otro sitio: cualquier cálculo que se colara en
 * el navegador sería un segundo sitio donde el dinero se suma.
 */

export interface CurrencyView {
  currency: string;
  outstanding: string;
  outstandingValue: number;
  invoiced: string;
  paid: string;
  openInvoices: number;
  ageDays: number | null;
  overdue: string;
  overdueInvoices: number;
}

export interface ReceivablesView {
  today: string;
  byCurrency: CurrencyView[];
  confirmedInvoices: number;
  pendingExcluded: number;
  disputedPayments: number;
  unappliedPayments: number;
  /** La frase honesta, tal cual la construye el módulo. Se muestra entera. */
  sentence: string;
}

export interface VersionView {
  source: string;
  amount: string;
  /**
   * El mismo importe como número. Va aparte de la cadena a propósito: volver a
   * sacar el número de "$4.200.000 COP" en el navegador daría 4,2 — el punto es
   * separador de miles en es-CO — y ese número acabaría en un formulario que
   * resuelve una disputa. Formatear es un viaje de ida.
   */
  amountValue: number;
  currency: string;
  paidOn: string;
  quote: string | null;
  /** Sólo ordena la lista. No decide nada. */
  rank: number;
}

export interface DisputeView {
  paymentId: string;
  client: string | null;
  currency: string;
  standingAmount: string;
  standingValue: number;
  paidOn: string;
  invoiceNumber: string | null;
  versions: VersionView[];
  /** Lo que la casilla trae marcada de entrada. Una sugerencia, no un veredicto. */
  suggested: number | null;
  note: string | null;
}

export interface PaymentView {
  id: string;
  kind: PaymentKind;
  kindLabel: string;
  amount: string;
  currency: string;
  paidOn: string;
  client: string | null;
  invoiceNumber: string | null;
  state: PaymentState;
  sourceCount: number;
}

export interface ClientOption {
  id: string;
  name: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  note?: string;
}
