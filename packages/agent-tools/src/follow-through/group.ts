/**
 * AGRUPAR LO QUE ESPERA PERMISO: «APROBAR LAS 6» O «REVISAR UNA POR UNA».
 *
 * Cuando la cartera se vence en tanda, Cortex redacta seis cobros que se
 * parecen como gotas de agua: misma herramienta, mismo tipo, mismos campos. Hoy
 * eso son seis tarjetas y doce clics, y lo que pasa en la práctica es que
 * nadie los abre y se quedan en «te espera tu aprobación» hasta que vencen.
 *
 * Esto decide cuáles se parecen lo bastante para ofrecerse juntos. Es puro —ni
 * base, ni reloj, ni red— porque lo que decide es qué se aprueba con UN clic, y
 * eso se prueba caso por caso en Node, no mirando la pantalla.
 *
 * ===========================================================================
 * QUÉ ES «PARECIDO»
 * ===========================================================================
 * La misma herramienta, la misma clase (para las acciones: cobro, recordatorio,
 * respuesta) y la misma FORMA de entrada: los mismos campos con contenido. Dos
 * correos, uno con copia y otro sin ella, siguen siendo el mismo envío — la
 * copia, el hilo y la marca de repetir se ignoran al comparar. Un correo y una
 * escritura en una tabla jamás caen juntos.
 *
 * ===========================================================================
 * LO QUE NUNCA ENTRA EN «APROBAR LAS N»
 * ===========================================================================
 * Lo que repite algo que ya se hizo (0168). Aprobarlo es repetirlo a sabiendas,
 * y eso se decide mirando esa tarjeta, no de paso dentro de un lote. Sigue
 * apareciendo en el grupo —para que la cuenta cuadre con lo que se ve— pero
 * fuera del botón, y la pantalla lo dice.
 *
 * Aprobar en lote NO es un atajo de seguridad: cada elemento sigue pasando por
 * su propio reclamo, su auditoría y su ejecución (lib/approvals/decide.ts,
 * lib/actions/decide.ts). Lo único que se ahorra es el clic.
 */

/** Lo mínimo de algo pendiente para poder agruparlo. */
export interface PendingLike {
  id: string;
  toolId: string;
  /** Para las acciones: su clase (`collect_payment`). Separa grupos dentro de la misma herramienta. */
  kind?: string | null;
  input: unknown;
  createdAt: string;
  /** Repite algo que ya se hizo: se muestra en el grupo pero no entra en el lote. */
  repeat?: boolean;
}

export interface PendingGroup<T extends PendingLike> {
  key: string;
  toolId: string;
  kind: string | null;
  /** Todos, el más viejo primero. */
  items: T[];
  /** Los que entran en «Aprobar las N». */
  batchable: T[];
  /** Los que hay que mirar uno por uno (repiten algo ya hecho). */
  heldBack: T[];
  oldestAt: string;
}

export interface GroupedPending<T extends PendingLike> {
  groups: PendingGroup<T>[];
  /** Lo que no se parece a nada: sigue en su tarjeta, en el orden en que llegó. */
  singles: T[];
}

/**
 * Campos que no cambian QUÉ se hace, sólo cómo se adorna: no separan grupos.
 * `repeatConfirmedByUser` es la marca de repetir de safe-actions/runtime.ts.
 */
const DECORATION_KEYS = new Set(['cc', 'bcc', 'threadId', 'repeatConfirmedByUser']);

/** Cuántos caben en un lote. Más que esto es para revisarlo con calma. */
export const MAX_BATCH = 25;

/** Desde cuántos parecidos se ofrece el lote. Uno solo no es un grupo. */
export const MIN_GROUP = 2;

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'list';
  return typeof value;
}

/**
 * La forma de una entrada: sus campos con contenido y de qué tipo es cada uno,
 * en orden. `{to, subject, body}` y `{body, to, subject, cc}` dan la misma.
 */
export function inputShape(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeOf(input);
  const record = input as Record<string, unknown>;
  return Object.keys(record)
    .filter((k) => !DECORATION_KEYS.has(k) && hasContent(record[k]))
    .sort()
    .map((k) => `${k}:${typeOf(record[k])}`)
    .join(',');
}

export function pendingGroupKey(item: PendingLike): string {
  return `${item.toolId}|${item.kind ?? ''}|${inputShape(item.input)}`;
}

function at(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Los grupos de parecidos y lo que queda suelto.
 *
 * Los grupos salen del más grande al más chico (a igual tamaño, el que lleva
 * más tiempo esperando primero): lo que más clics ahorra va arriba. Dentro de
 * cada grupo, el más viejo primero, con el id de desempate para que el orden no
 * dependa de cómo llegaron de Postgres. Los sueltos conservan el orden de
 * entrada, que es el de la pantalla que los pidió.
 */
export function groupPendingApprovals<T extends PendingLike>(
  items: readonly T[],
  opts: { minSize?: number; maxBatch?: number } = {},
): GroupedPending<T> {
  const minSize = Math.max(2, opts.minSize ?? MIN_GROUP);
  const maxBatch = Math.max(1, opts.maxBatch ?? MAX_BATCH);
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = pendingGroupKey(item);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }

  const groups: PendingGroup<T>[] = [];
  const grouped = new Set<string>();
  for (const [key, list] of byKey) {
    if (list.length < minSize) continue;
    const sorted = [...list].sort(
      (a, b) => at(a.createdAt) - at(b.createdAt) || a.id.localeCompare(b.id),
    );
    const fresh = sorted.filter((i) => !i.repeat);
    // Un «grupo» en el que sólo uno se puede aprobar de una vez no ahorra
    // nada: se queda en tarjetas sueltas.
    if (fresh.length < minSize) continue;
    const first = sorted[0] as T;
    groups.push({
      key,
      toolId: first.toolId,
      kind: first.kind ?? null,
      items: sorted,
      batchable: fresh.slice(0, maxBatch),
      heldBack: [...sorted.filter((i) => i.repeat), ...fresh.slice(maxBatch)],
      oldestAt: first.createdAt,
    });
    for (const i of sorted) grouped.add(i.id);
  }

  groups.sort(
    (a, b) =>
      b.items.length - a.items.length ||
      at(a.oldestAt) - at(b.oldestAt) ||
      a.key.localeCompare(b.key),
  );
  return { groups, singles: items.filter((i) => !grouped.has(i.id)) };
}

/** Cómo se nombran, en plural y en singular, los de cada clase de acción. */
const ACTION_KIND_NOUN: Record<string, [string, string]> = {
  collect_payment: ['cobro de cartera', 'cobros de cartera'],
  remind_owner: ['recordatorio de vencimiento', 'recordatorios de vencimiento'],
  reply_to_client: ['respuesta a un cliente', 'respuestas a clientes'],
};

/** Por herramienta, cuando no hay clase. Lo demás cae a «acciones parecidas». */
const TOOL_NOUN: Record<string, [string, string]> = {
  'gmail.send_message': ['correo', 'correos'],
  'outlook.send_message': ['correo', 'correos'],
  'trackers.upsert_row': ['fila de tabla', 'filas de tabla'],
  'work.assign': ['reasignación', 'reasignaciones'],
  'payments.register': ['pago por registrar', 'pagos por registrar'],
};

/** «6 cobros de cartera», «2 correos», «3 acciones parecidas». */
export function pendingGroupTitle(
  group: Pick<PendingGroup<PendingLike>, 'toolId' | 'kind' | 'items'>,
): string {
  const n = group.items.length;
  const noun = (group.kind ? ACTION_KIND_NOUN[group.kind] : undefined) ?? TOOL_NOUN[group.toolId];
  if (noun) return `${n} ${n === 1 ? noun[0] : noun[1]}`;
  return `${n} ${n === 1 ? 'acción parecida' : 'acciones parecidas'}`;
}

/** El texto del botón: «Aprobar los 6», «Aprobar las 3». */
export function batchApproveLabel(
  group: Pick<PendingGroup<PendingLike>, 'toolId' | 'kind' | 'batchable'>,
): string {
  const n = group.batchable.length;
  const noun = (group.kind ? ACTION_KIND_NOUN[group.kind] : undefined) ?? TOOL_NOUN[group.toolId];
  // El género lo pone el sustantivo: cobros, correos, recordatorios → los;
  // respuestas, filas, reasignaciones, acciones → las.
  const plural = noun?.[1] ?? 'acciones';
  const feminine = /^(respuestas|filas|reasignaciones|acciones)/.test(plural);
  return `Aprobar ${feminine ? 'las' : 'los'} ${n}`;
}
