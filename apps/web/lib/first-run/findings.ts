/**
 * «TU PRIMER RESUMEN»: de los datos de la empresa a tres–cinco hallazgos.
 *
 * Pura. `read.ts` junta lo que hay (con tope por consulta); aquí se decide qué
 * vale la pena decir, en qué orden y con qué siguiente paso. Cada hallazgo
 * sólo existe si hay datos que lo respalden: nada se inventa para llenar.
 */

export interface FindingsInput {
  today: string; // YYYY-MM-DD en hora de Bogotá
  receivables: {
    count: number;
    total: number;
    currency: string;
    top: Array<{ name: string; balance: number; daysLate: number }>;
  };
  payables: {
    count: number;
    total: number;
    currency: string;
    next: { supplier: string; dueOn: string; total: number } | null;
  };
  expiring: Array<{ title: string; expiresOn: string }>;
  topClients: Array<{ name: string; invoices: number }>;
  commitments: { overdue: number; oldestTitle: string | null };
  documentsReady: number;
}

export type FindingTone = 'alert' | 'warn' | 'info';
export type FindingAction =
  | { kind: 'chat'; label: string; prompt: string }
  | { kind: 'link'; label: string; href: string };

export interface Finding {
  id: string;
  tone: FindingTone;
  title: string;
  detail: string;
  action: FindingAction;
}

export const MAX_FINDINGS = 5;

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const PRIORITY: Record<string, number> = {
  receivables: 1,
  expiring: 2,
  payables: 3,
  commitments: 4,
  clients: 5,
  documents: 6,
};

export function buildFindings(input: FindingsInput): Finding[] {
  const out: Array<Finding & { p: number }> = [];

  const r = input.receivables;
  if (r.count > 0 && r.total > 0) {
    const top = r.top[0];
    out.push({
      p: PRIORITY.receivables ?? 9,
      id: 'receivables',
      tone: 'alert',
      title: `Te deben ${money(r.total, r.currency)} en ${r.count} ${r.count === 1 ? 'factura vencida' : 'facturas vencidas'}`,
      detail: top
        ? `La más pesada es de ${top.name}: ${money(top.balance, r.currency)}, con ${top.daysLate} ${top.daysLate === 1 ? 'día' : 'días'} de atraso.`
        : 'Están pasadas de fecha y todavía con saldo.',
      action: {
        kind: 'chat',
        label: 'Pídeselo a Cortex',
        prompt:
          'Muéstrame mi cartera vencida, de la más antigua a la más reciente, y prepárame un borrador de cobro amable para las tres más grandes. No envíes nada.',
      },
    });
  }

  const exp = input.expiring
    .map((e) => ({ ...e, left: daysBetween(input.today, e.expiresOn) }))
    .filter((e) => e.left <= 60)
    .sort((a, b) => a.left - b.left);
  if (exp.length > 0) {
    const first = exp[0];
    if (first) {
      const when =
        first.left < 0
          ? `venció hace ${-first.left} ${-first.left === 1 ? 'día' : 'días'}`
          : first.left === 0
            ? 'vence hoy'
            : `vence en ${first.left} ${first.left === 1 ? 'día' : 'días'}`;
      out.push({
        p: PRIORITY.expiring ?? 9,
        id: 'expiring',
        tone: first.left < 0 ? 'alert' : 'warn',
        title:
          exp.length === 1
            ? `«${first.title}» ${when}`
            : `${exp.length} documentos vencen pronto o ya vencieron`,
        detail:
          exp.length === 1
            ? 'Lo leí de tus documentos; conviene renovarlo a tiempo.'
            : `El primero: «${first.title}», ${when}.`,
        action: { kind: 'link', label: 'Ver los vencimientos', href: '/documentos-vencen' },
      });
    }
  }

  const p = input.payables;
  if (p.count > 0 && p.total > 0) {
    const next = p.next;
    out.push({
      p: PRIORITY.payables ?? 9,
      id: 'payables',
      tone: 'warn',
      title: `Tienes ${p.count} ${p.count === 1 ? 'factura por pagar' : 'facturas por pagar'} (${money(p.total, p.currency)})`,
      detail: next
        ? `La próxima vence el ${next.dueOn}: ${next.supplier}, ${money(next.total, p.currency)}.`
        : 'Todavía no tienen fecha de vencimiento clara.',
      action: {
        kind: 'chat',
        label: 'Pídeselo a Cortex',
        prompt:
          'Dime qué facturas de proveedores tengo por pagar en los próximos 15 días y propón un orden de pago según el vencimiento.',
      },
    });
  }

  if (input.commitments.overdue > 0) {
    const c = input.commitments;
    out.push({
      p: PRIORITY.commitments ?? 9,
      id: 'commitments',
      tone: 'warn',
      title: `${c.overdue} ${c.overdue === 1 ? 'compromiso sin cumplir' : 'compromisos sin cumplir'}`,
      detail: c.oldestTitle ? `El más viejo: «${c.oldestTitle}».` : 'Ya pasó su fecha.',
      action: {
        kind: 'chat',
        label: 'Pídeselo a Cortex',
        prompt: 'Lista mis compromisos vencidos y dime a quién le toca mover cada uno.',
      },
    });
  }

  if (input.topClients.length > 0) {
    const names = input.topClients.slice(0, 3).map((c) => c.name);
    out.push({
      p: PRIORITY.clients ?? 9,
      id: 'clients',
      tone: 'info',
      title: `Tus clientes más activos: ${names.join(', ')}`,
      detail: `${input.topClients[0]?.name} lleva ${input.topClients[0]?.invoices} facturas en los últimos 90 días.`,
      action: {
        kind: 'chat',
        label: 'Pídeselo a Cortex',
        prompt:
          'Arma un resumen de mis tres clientes con más facturación de los últimos 90 días: cuánto me deben, qué compraron y cuándo hablamos por última vez.',
      },
    });
  }

  if (out.length < 3 && input.documentsReady > 0) {
    out.push({
      p: PRIORITY.documents ?? 9,
      id: 'documents',
      tone: 'info',
      title: `Ya leí ${input.documentsReady} ${input.documentsReady === 1 ? 'documento' : 'documentos'} de tu empresa`,
      detail: 'Puedes preguntarme lo que dicen, con la fuente a la vista.',
      action: {
        kind: 'chat',
        label: 'Pídeselo a Cortex',
        prompt:
          'Hazme un resumen de los documentos más importantes que has leído de mi empresa y qué debería revisar primero.',
      },
    });
  }

  return out
    .sort((a, b) => a.p - b.p)
    .slice(0, MAX_FINDINGS)
    .map(({ p: _p, ...f }) => f);
}

/** El enlace al chat con la petición escrita. */
export function chatHref(prompt: string): string {
  return `/chat?prompt=${encodeURIComponent(prompt.slice(0, 1800))}`;
}
