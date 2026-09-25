import {
  type RenderedEmail,
  appBaseUrl,
  button,
  calloutBox,
  fineprint,
  keyValueTable,
  lede,
  renderEmail,
  statRow,
  statusPill,
} from '@/lib/email-templates';
import type { MoneyAtRisk, OverdueInvoice, OverdueStage } from '@cortex/agent-tools';

/**
 * EL CORREO DE LA CARTERA QUE AVISA SOLA.
 *
 * Uno por espacio y por día, y sólo si alguna factura CRUZÓ un escalón de mora
 * hoy (ver OVERDUE_STAGES). Dice primero lo nuevo —qué facturas pasaron qué
 * línea— y después el tamaño del problema entero, porque una factura que se
 * fue a 60 días se entiende distinto al lado de «y en total hay 38 millones
 * vencidos».
 *
 * El método va escrito: sólo facturas confirmadas, saldo después de los pagos
 * atados a cada una, monedas por separado. Es lo que hace que el aviso se pueda
 * comprobar en cinco minutos, y comprobarlo una vez es lo que hace que el
 * siguiente se lea. Mismo argumento que goal-notice-email.ts.
 *
 * Sin `server-only` ni base de datos: construye texto.
 */

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function money(amount: number, currency: string): string {
  if (currency.trim().toUpperCase() === 'COP') return COP.format(amount);
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(amount)} ${currency.toUpperCase()}`;
}

export interface CrossedInvoice extends OverdueInvoice {
  stage: OverdueStage;
  clientName: string | null;
}

function stageText(stage: OverdueStage): string {
  return stage === 1 ? 'venció' : `pasó los ${stage} días`;
}

function who(inv: CrossedInvoice): string {
  return inv.clientName ?? inv.counterparty ?? 'cliente sin nombre';
}

export function renderReceivablesNoticeEmail(input: {
  organizationName: string;
  crossed: CrossedInvoice[];
  risk: MoneyAtRisk;
}): RenderedEmail {
  const { crossed, risk } = input;
  const worst = Math.max(...crossed.map((c) => c.stage));
  const subject =
    crossed.length === 1 && crossed[0]
      ? `Cartera: la factura de ${who(crossed[0])} ${stageText(crossed[0].stage)} (${money(crossed[0].balance, crossed[0].currency)})`
      : `Cartera: ${crossed.length} facturas cruzaron un plazo de mora hoy`;

  const shown = crossed.slice(0, 12);
  const rows = shown.map((inv) => ({
    label: `${who(inv)}${inv.docNumber ? ` · ${inv.docNumber}` : ''}`,
    value: `${money(inv.balance, inv.currency)} — ${inv.daysOverdue} días de mora (vencía el ${inv.dueOn})`,
  }));

  const stats = [
    { label: 'Cartera vencida', value: COP.format(risk.cop.receivablesOverdue) },
    { label: 'Facturas vencidas', value: String(risk.cop.overdueInvoices) },
    ...(risk.cop.total > risk.cop.receivablesOverdue
      ? [{ label: 'Plata en riesgo', value: COP.format(risk.cop.total) }]
      : []),
  ];

  const others = risk.otherCurrencies
    .map((o) => `${money(o.receivablesOverdue, o.currency)} (${o.overdueInvoices})`)
    .join(', ');

  const base = appBaseUrl();
  const bodyHtml = [
    lede(
      crossed.length === 1
        ? 'Una factura por cobrar cruzó hoy un plazo de mora. Es un buen momento para llamar o escribir antes de que pase al siguiente.'
        : 'Estas facturas por cobrar cruzaron hoy un plazo de mora. Cada una avisa una sola vez por plazo: al vencer, a los 30, a los 60 y a los 90 días.',
    ),
    keyValueTable(rows),
    crossed.length > shown.length
      ? fineprint(`Y ${crossed.length - shown.length} más en la cartera.`)
      : '',
    statRow(stats),
    others ? fineprint(`En otras monedas, vencido: ${others}. No se suman a los pesos.`) : '',
    risk.cop.paymentsOverdue + risk.cop.paymentsDueSoon > 0
      ? calloutBox({
          tone: 'warn',
          title: 'Lo que la empresa tiene que pagar',
          text: `Además hay ${COP.format(risk.cop.paymentsOverdue)} en pagos comprometidos vencidos y ${COP.format(risk.cop.paymentsDueSoon)} que vencen esta semana.`,
        })
      : '',
    base ? button({ href: `${base}/payments`, label: 'Abrir la cartera' }) : '',
    fineprint(
      'Sólo cuentan facturas confirmadas; el saldo descuenta los pagos atados a cada factura. Las que están sin revisar no entran en estas cifras.',
    ),
  ].join('');

  const html = renderEmail({
    title:
      crossed.length === 1
        ? 'Una factura cruzó un plazo de mora'
        : `${crossed.length} facturas cruzaron un plazo de mora`,
    preheader: `Cartera vencida: ${COP.format(risk.cop.receivablesOverdue)} en ${risk.cop.overdueInvoices} facturas.`,
    eyebrow: `Cartera · ${input.organizationName}`,
    pillHtml: statusPill({
      label: worst >= 60 ? 'Urgente' : 'Atención',
      tone: worst >= 60 ? 'danger' : 'warn',
    }),
    bodyHtml,
    footerNote: 'Te llega porque administras este espacio en Cortex.',
  });

  const text = [
    subject,
    '',
    ...shown.map(
      (r, i) =>
        `${i + 1}. ${who(r)}${r.docNumber ? ` (${r.docNumber})` : ''}: ${money(r.balance, r.currency)}, ${r.daysOverdue} días de mora.`,
    ),
    '',
    `Cartera vencida: ${COP.format(risk.cop.receivablesOverdue)} en ${risk.cop.overdueInvoices} facturas.`,
    others ? `Otras monedas: ${others}.` : '',
    base ? `Abrir la cartera: ${base}/payments` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, html, text };
}
