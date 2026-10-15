import { moneyText } from '../../ledger/shape';
import { classifyPayrollAccount } from '../payroll';

/**
 * CONSULTA EN VIVO AL PROGRAMA CONTABLE: LA FORMA COMÚN Y LO PURO (sólo lectura).
 *
 * Nada de aquí habla con un programa: recibe documentos ya normalizados
 * (`LiveDoc`) y hace lo que es igual para todos: filtrar, agrupar, sumar,
 * esconder la nómina a quien no administra y escribir el markdown corto. Cada
 * programa (siigo-live.ts) sólo traduce su respuesta a `LiveDoc`.
 */

export const LIVE_RESOURCES = [
  'facturas_venta',
  'notas_credito',
  'compras',
  'documento_soporte',
  'recibos_caja',
  'pagos',
  'comprobantes',
  'terceros',
  'productos',
  'impuestos',
  'balance_prueba',
] as const;
export type LiveResource = (typeof LIVE_RESOURCES)[number];

export const LIVE_RESOURCE_LABEL: Record<LiveResource, string> = {
  facturas_venta: 'facturas de venta',
  notas_credito: 'notas crédito',
  compras: 'compras (facturas de proveedor)',
  documento_soporte: 'documentos soporte',
  recibos_caja: 'recibos de caja',
  pagos: 'pagos y egresos',
  comprobantes: 'comprobantes contables',
  terceros: 'terceros',
  productos: 'productos',
  impuestos: 'impuestos',
  balance_prueba: 'balance de prueba',
};

export const LIVE_GROUPS = ['ninguna', 'mes', 'tercero', 'cuenta', 'producto'] as const;
export type LiveGroupBy = (typeof LIVE_GROUPS)[number];

export const LIVE_STATUSES = ['todas', 'con_saldo', 'pagada', 'anulada'] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export const CONFIDENTIAL_PARTY = 'Nómina (confidencial)';

export interface LiveRequest {
  resource: LiveResource;
  /** AAAA-MM-DD. */
  from?: string;
  to?: string;
  /** NIT/cédula (dígitos) o parte del nombre. */
  party?: string;
  /** Número o prefijo del documento («FV-1-1234», «RC»). */
  number?: string;
  /** Cuenta PUC o prefijo («1305», «5105»). */
  account?: string;
  status?: LiveStatus;
  groupBy?: LiveGroupBy;
  /** Cuántos documentos listar (los totales cubren todos los revisados). */
  limit?: number;
  /** Con líneas (ítems / cuentas) en cada documento listado. */
  includeLines?: boolean;
  /** Terceros: cliente, proveedor o todos. */
  relationship?: 'cliente' | 'proveedor' | 'todos';
  /** Balance de prueba: dígitos del nivel (1, 2, 4, 6…). */
  level?: number;
  /** Tope de documentos a revisar. */
  maxDocuments?: number;
  /** Quién pregunta ve la nómina por persona (administrador o dueño). */
  canSeePayroll: boolean;
}

export interface LiveLine {
  account?: string;
  accountName?: string;
  movement?: 'debit' | 'credit';
  party?: string;
  description?: string;
  product?: string;
  quantity?: number;
  /** Siempre positivo; en comprobantes el sentido lo dice `movement`. */
  value: number;
}

export interface LiveDoc {
  id: string;
  number: string;
  /** AAAA-MM-DD. */
  date: string;
  partyId?: string;
  partyName?: string;
  total: number;
  balance?: number;
  status?: 'open' | 'paid' | 'annulled';
  currency: string;
  dueDate?: string;
  note?: string;
  lines?: LiveLine[];
}

export interface LiveGroup {
  key: string;
  label: string;
  count: number;
  total: number;
  balance?: number;
  debit?: number;
  credit?: number;
}

export interface LiveRecord {
  /** Terceros, productos, impuestos: filas planas ya legibles. */
  id: string;
  title: string;
  detail: string;
}

export interface LiveTrialRow {
  code: string;
  name: string;
  initial: number;
  debit: number;
  credit: number;
  final: number;
}

export interface LiveResult {
  provider: string;
  resource: LiveResource;
  currency: string;
  docs: LiveDoc[];
  records: LiveRecord[];
  trial: LiveTrialRow[];
  groups: LiveGroup[];
  totals: { count: number; total: number; balance: number | null };
  /** Documentos revisados (después de filtrar los que no calzaron). */
  scanned: number;
  /** Documentos que el programa dice que hay en el rango (antes de filtrar localmente). */
  reported: number | null;
  /** Se detuvo antes de leer todo el rango. */
  partial: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Filtros locales
// ---------------------------------------------------------------------------

const digits = (s: string) => s.replace(/\D/g, '');
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** ¿Es una línea de nómina que esta persona no puede ver con detalle? */
export function isHiddenPayrollLine(line: LiveLine, canSeePayroll: boolean): boolean {
  return !canSeePayroll && classifyPayrollAccount(line.account) !== null;
}

/** ¿El comprobante trae líneas de nómina? */
export function hasPayrollLines(doc: LiveDoc): boolean {
  return (doc.lines ?? []).some((l) => classifyPayrollAccount(l.account) !== null);
}

/**
 * Quita lo confidencial de un comprobante para quien no administra: de las
 * líneas de nómina se va el tercero (la persona) y la descripción; del
 * comprobante, la observación. Las cifras por cuenta se quedan: son del total
 * de la empresa.
 */
export function maskPayroll(doc: LiveDoc, canSeePayroll: boolean): LiveDoc {
  if (canSeePayroll || !hasPayrollLines(doc)) return doc;
  return {
    ...doc,
    note: undefined,
    lines: (doc.lines ?? []).map((l) =>
      classifyPayrollAccount(l.account)
        ? { ...l, party: CONFIDENTIAL_PARTY, description: undefined }
        : l,
    ),
  };
}

function partyMatches(party: string, id?: string, name?: string): boolean {
  const q = party.trim();
  if (!q) return true;
  const d = digits(q);
  if (d.length >= 5 && d === q.replace(/[\s.\-]/g, '')) return digits(id ?? '').startsWith(d);
  return fold(name ?? '').includes(fold(q)) || fold(id ?? '').includes(fold(q));
}

/** ¿El documento pasa los filtros que el programa no sabe hacer por sí mismo? */
export function docMatches(doc: LiveDoc, req: LiveRequest): boolean {
  if (req.from && doc.date < req.from) return false;
  if (req.to && doc.date > req.to) return false;
  if (req.number) {
    const n = fold(req.number).replace(/\s+/g, '');
    if (!fold(doc.number).replace(/\s+/g, '').includes(n)) return false;
  }
  if (req.status && req.status !== 'todas') {
    const s =
      doc.status ??
      (doc.balance === undefined ? undefined : doc.balance > 0.004 ? 'open' : 'paid');
    if (req.status === 'con_saldo' && s !== 'open') return false;
    if (req.status === 'pagada' && s !== 'paid') return false;
    if (req.status === 'anulada' && s !== 'annulled') return false;
  }
  if (req.party) {
    const lines = (doc.lines ?? []).filter((l) => !isHiddenPayrollLine(l, req.canSeePayroll));
    const onDoc = partyMatches(req.party, doc.partyId, doc.partyName);
    const onLines = lines.some((l) => partyMatches(req.party as string, l.party, l.party));
    if (!onDoc && !onLines) return false;
  }
  if (req.account) {
    const prefix = digits(req.account);
    if (prefix && !(doc.lines ?? []).some((l) => digits(l.account ?? '').startsWith(prefix)))
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Agrupar
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Lo que pesa una línea con sentido: débito suma, crédito resta. */
const signed = (l: LiveLine) => (l.movement === 'credit' ? -l.value : l.value);

export function groupDocs(
  docs: LiveDoc[],
  groupBy: LiveGroupBy,
  opts: { account?: string; level?: number; canSeePayroll: boolean },
): LiveGroup[] {
  if (groupBy === 'ninguna') return [];
  const map = new Map<string, LiveGroup>();
  const bump = (
    key: string,
    label: string,
    patch: { total?: number; balance?: number; debit?: number; credit?: number },
    countDoc: boolean,
  ) => {
    const g = map.get(key) ?? { key, label, count: 0, total: 0 };
    if (countDoc) g.count += 1;
    g.total = round2(g.total + (patch.total ?? 0));
    if (patch.balance !== undefined) g.balance = round2((g.balance ?? 0) + patch.balance);
    if (patch.debit !== undefined) g.debit = round2((g.debit ?? 0) + patch.debit);
    if (patch.credit !== undefined) g.credit = round2((g.credit ?? 0) + patch.credit);
    map.set(key, g);
  };
  const prefix = digits(opts.account ?? '');
  for (const d of docs) {
    if (groupBy === 'mes') {
      bump(d.date.slice(0, 7), d.date.slice(0, 7), { total: d.total, balance: d.balance }, true);
    } else if (groupBy === 'tercero') {
      const hidden = hasPayrollLines(d) && !opts.canSeePayroll;
      const key = hidden ? CONFIDENTIAL_PARTY : (d.partyId ?? d.partyName ?? 'sin tercero');
      const label = hidden ? CONFIDENTIAL_PARTY : (d.partyName ?? d.partyId ?? 'Sin tercero');
      bump(key, label, { total: d.total, balance: d.balance }, true);
    } else if (groupBy === 'producto') {
      const seen = new Set<string>();
      for (const l of d.lines ?? []) {
        const label = l.product ?? l.description ?? 'Sin producto';
        const key = fold(label);
        bump(key, label, { total: l.value }, !seen.has(key));
        seen.add(key);
      }
    } else if (groupBy === 'cuenta') {
      const seen = new Set<string>();
      for (const l of d.lines ?? []) {
        const code = digits(l.account ?? '');
        if (!code || (prefix && !code.startsWith(prefix))) continue;
        const key = opts.level ? code.slice(0, opts.level) : code;
        bump(
          key,
          l.accountName && key === code ? `${key} ${l.accountName}` : key,
          {
            total: l.movement === 'credit' ? -l.value : l.value,
            debit: l.movement === 'credit' ? 0 : l.value,
            credit: l.movement === 'credit' ? l.value : 0,
          },
          !seen.has(key),
        );
        seen.add(key);
      }
    }
  }
  const out = [...map.values()];
  return groupBy === 'mes' ? out.sort((a, b) => a.key.localeCompare(b.key)) : out.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

export function totalsOf(docs: LiveDoc[]): LiveResult['totals'] {
  const hasBalance = docs.some((d) => d.balance !== undefined);
  return {
    count: docs.length,
    total: round2(docs.reduce((s, d) => s + d.total, 0)),
    balance: hasBalance ? round2(docs.reduce((s, d) => s + (d.balance ?? 0), 0)) : null,
  };
}

/** Sólo las líneas de la cuenta pedida, si pidió una. */
export function trimLinesToAccount(doc: LiveDoc, account?: string): LiveDoc {
  const prefix = digits(account ?? '');
  if (!prefix || !doc.lines) return doc;
  return { ...doc, lines: doc.lines.filter((l) => digits(l.account ?? '').startsWith(prefix)) };
}

// ---------------------------------------------------------------------------
// Markdown corto
// ---------------------------------------------------------------------------

const money = (n: number, cur: string) => moneyText(n, cur);

function lineText(l: LiveLine, cur: string): string {
  const who = l.party ? ` · ${l.party}` : '';
  if (l.account)
    return `${l.account}${l.accountName ? ` ${l.accountName}` : ''}: ${l.movement === 'credit' ? 'crédito' : 'débito'} ${money(l.value, cur)}${who}`;
  return `${l.product ?? l.description ?? 'Ítem'}${l.quantity !== undefined ? ` × ${l.quantity}` : ''}: ${money(l.value, cur)}`;
}

export function renderLive(r: LiveResult, req: LiveRequest): string {
  const out: string[] = [];
  const label = LIVE_RESOURCE_LABEL[r.resource];
  const range = req.from || req.to ? ` del ${req.from ?? 'inicio'} al ${req.to ?? 'hoy'}` : '';
  const cur = r.currency;

  if (r.resource === 'balance_prueba') {
    out.push(`### Balance de prueba${range} (${r.provider}, en vivo)`);
    if (!r.trial.length) out.push('No hay cuentas con movimiento para ese filtro.');
    else {
      out.push('| Cuenta | Nombre | Saldo inicial | Débitos | Créditos | Saldo final |', '|---|---|---:|---:|---:|---:|');
      for (const t of r.trial.slice(0, req.limit ?? 50))
        out.push(
          `| ${t.code} | ${t.name} | ${money(t.initial, cur)} | ${money(t.debit, cur)} | ${money(t.credit, cur)} | ${money(t.final, cur)} |`,
        );
      if (r.trial.length > (req.limit ?? 50))
        out.push(`Faltan ${r.trial.length - (req.limit ?? 50)} cuentas más; acota por cuenta o nivel.`);
    }
  } else if (r.records.length || ['terceros', 'productos', 'impuestos'].includes(r.resource)) {
    out.push(`### ${label[0]?.toUpperCase()}${label.slice(1)} (${r.provider}, en vivo)`);
    if (!r.records.length) out.push('No encontré registros con ese filtro.');
    for (const rec of r.records) out.push(`- **${rec.title}** — ${rec.detail}`);
    if (r.partial)
      out.push(`Revisé ${r.scanned} de ${r.reported ?? 'más'}; acota el filtro para ver el resto.`);
  } else {
    out.push(`### ${label[0]?.toUpperCase()}${label.slice(1)}${range} (${r.provider}, en vivo)`);
    if (!r.totals.count) out.push('No hay documentos con ese filtro.');
    else
      out.push(
        `${r.totals.count} documento(s) · total ${money(r.totals.total, cur)}${r.totals.balance !== null ? ` · saldo pendiente ${money(r.totals.balance, cur)}` : ''}.`,
      );
    if (r.groups.length) {
      const by = req.groupBy ?? 'ninguna';
      const head =
        by === 'cuenta'
          ? '| Cuenta | Documentos | Débitos | Créditos | Neto |'
          : '| Grupo | Documentos | Total | Saldo |';
      out.push(head, by === 'cuenta' ? '|---|---:|---:|---:|---:|' : '|---|---:|---:|---:|');
      for (const g of r.groups.slice(0, 40))
        out.push(
          by === 'cuenta'
            ? `| ${g.label} | ${g.count} | ${money(g.debit ?? 0, cur)} | ${money(g.credit ?? 0, cur)} | ${money(g.total, cur)} |`
            : `| ${g.label} | ${g.count} | ${money(g.total, cur)} | ${g.balance === undefined ? '—' : money(g.balance, cur)} |`,
        );
      if (r.groups.length > 40) out.push(`Y ${r.groups.length - 40} grupos más (los de menor valor).`);
    }
    const shown = r.docs.slice(0, req.limit ?? 50);
    if (shown.length && (req.groupBy ?? 'ninguna') === 'ninguna') {
      out.push('', '| Fecha | Documento | Tercero | Total | Saldo |', '|---|---|---|---:|---:|');
      for (const d of shown)
        out.push(
          `| ${d.date} | ${d.number} | ${d.partyName ?? d.partyId ?? '—'} | ${money(d.total, cur)} | ${d.balance === undefined ? '—' : money(d.balance, cur)} |`,
        );
      if (r.docs.length > shown.length)
        out.push(`Faltan ${r.docs.length - shown.length} documentos por listar (los totales ya los incluyen).`);
      if (req.includeLines)
        for (const d of shown.slice(0, 15))
          if (d.lines?.length)
            out.push(
              '',
              `**${d.number}** (${d.date})`,
              ...d.lines.slice(0, 25).map((l) => `- ${lineText(l, cur)}`),
            );
    }
  }
  if (r.partial && r.resource !== 'terceros' && r.resource !== 'productos')
    out.push(
      `ATENCIÓN: sólo alcancé a revisar ${r.scanned}${r.reported ? ` de ${r.reported}` : ''} documentos del rango; las sumas son parciales. Acota el rango de fechas (por ejemplo mes a mes) o el tercero.`,
    );
  for (const n of r.notes) out.push(`Nota: ${n}`);
  return out.join('\n');
}
