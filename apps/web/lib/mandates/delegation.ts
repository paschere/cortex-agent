/**
 * LO QUE CORTEX HIZO SIN PREGUNTAR, DICHO DONDE OCURRIÓ.
 *
 * ===========================================================================
 * EL PROBLEMA QUE ESTE ARCHIVO EXISTE PARA CERRAR
 * ===========================================================================
 * La migración 0099 le dio a Cortex la capacidad de actuar sin preguntar dentro
 * de un mandato. Funciona, y hasta hoy era INVISIBLE: lo único que quedaba era
 * una fila en `audit_events` con `decision='delegated'` y otra en
 * `mandate_uses`. Nadie abre la auditoría, así que la autonomía que el producto
 * acababa de construir no se descubría hasta que algo salía mal — que es el peor
 * momento posible para enterarse de que existía.
 *
 * Este módulo es la mitad PURA de arreglar eso: compone la frase que acompaña a
 * cada acto delegado, agrupa los usos para que no se conviertan en ruido, y
 * decide qué aviso se enseña entero y cuál en una línea. La mitad de I/O vive en
 * `app/api/mandates/exercised/route.ts` y en `lib/mandates/store.ts`.
 *
 * No importa `server-only` a propósito: lo consumen tanto la ruta de servidor
 * como los componentes de chat, que son de cliente.
 *
 * ===========================================================================
 * LA RAZÓN SALE DE LA FILA. SIEMPRE, Y SOLO DE AHÍ
 * ===========================================================================
 * «Como me autorizaste el 3 de agosto» se compone de tres columnas de
 * `mandates` —`granted_by`, `created_at` y `label`— y de nada más. No hay una
 * llamada a un modelo por ningún lado, ni la habrá: una explicación de por qué
 * el producto actuó solo que estuviera GENERADA sería exactamente la clase de
 * frase que suena verdadera sin serlo, en el único sitio del producto donde la
 * persona no tuvo la oportunidad de decidir.
 *
 * De ahí que `authorizationPhrase` devuelva `null` cuando le falta la fecha o el
 * autor, en vez de rellenar el hueco. Un aviso que diga «actué bajo el mandato
 * X» sin fecha es incompleto; uno que se invente la fecha es peor que no decir
 * nada.
 *
 * ===========================================================================
 * LA REGLA DEL RUIDO, QUE ES LA MITAD DEL DISEÑO
 * ===========================================================================
 * Un mandato que se ejerce cuarenta veces al día produciría cuarenta avisos, y
 * cuarenta avisos se apagan solos: la persona deja de leerlos en el tercero y a
 * partir de ahí el aviso número cuarenta —el que importaba— es invisible. Así
 * que se agrupa en tres niveles, y cada uno tiene el mismo argumento detrás:
 *
 *   1. POR PERMISO, NO POR LLAMADA. La unidad de atención es la CONCESIÓN
 *      ejercida, no la llamada. Si en un turno Cortex mandó seis correos bajo el
 *      mismo mandato, eso es UN aviso con un contador («seis veces»), porque la
 *      decisión que la persona puede tomar —dejarlo o revocarlo— es idéntica
 *      para el correo uno y para el seis. Dos mandatos distintos en el mismo
 *      turno sí son dos avisos: son dos permisos, y llevan dos botones de
 *      revocar diferentes.
 *
 *   2. ENTERO LA PRIMERA VEZ, EN UNA LÍNEA LAS SIGUIENTES. Dentro de una misma
 *      conversación, la primera vez que un mandato actúa se enseña el aviso
 *      completo: qué hizo, por qué pudo, y el botón de revocar al lado. A partir
 *      de ahí el mismo mandato se anota en una línea discreta con el contador.
 *      La razón no cambia entre el turno tres y el diecisiete, y repetirla
 *      entera diecisiete veces no informa: gasta la atención que hace falta para
 *      el mandato NUEVO que aparezca en el turno dieciocho, que sí se enseña
 *      entero.
 *
 *   3. POR HERRAMIENTA EN LA PANTALLA DEL MANDATO. Cuarenta usos de la misma
 *      herramienta son UNA fila con un contador y la última fecha, no cuarenta
 *      filas. Un registro de eventos crudo ya existe —la auditoría— y lo que la
 *      pantalla del mandato tiene que contestar es otra cosa: qué se ha hecho
 *      bajo esta concesión y cuándo fue la última vez.
 *
 * Lo que NO se agrupa nunca: dos mandatos distintos, y la primera vez de cada
 * uno. Ahí es donde vive la información.
 */

import { toolDisplayName } from '@/lib/tool-labels';

/** Todo lo que este producto fecha, lo fecha en Bogotá. Ver `bogotaDayStart`. */
export const BOGOTA_TZ = 'America/Bogota';

// ---------------------------------------------------------------------------
// 1. Lo que viaja pegado al resultado de una herramienta
// ---------------------------------------------------------------------------

/**
 * El nombre del mandato que autorizó esta llamada, o null.
 *
 * `registry.ts` engancha un `_security` enumerable al resultado de toda llamada
 * que deje incidente, y le pone `delegatedBy` SOLO cuando una concesión levantó
 * la pregunta. O sea: la presencia de esa clave es la señal de que aquí hubo
 * autonomía, y viene del mismo sitio que la fila de auditoría. No se deduce de
 * ninguna otra cosa —ni del nivel de riesgo, ni del texto del aviso— porque
 * esas dos también aparecen en llamadas que la persona SÍ confirmó.
 *
 * Sobrevive a una recarga: los resultados se guardan tal cual en
 * `messages.tool_results`, y `toToolInvocations` los devuelve enteros.
 */
export function delegatedByOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const security = (result as { _security?: unknown })._security;
  if (!security || typeof security !== 'object') return null;
  const by = (security as { delegatedBy?: unknown }).delegatedBy;
  return typeof by === 'string' && by.trim() ? by.trim() : null;
}

/** Una llamada tal y como la trae el transcript del chat. */
export interface InvocationLike {
  toolName: string;
  state?: string;
  result?: unknown;
}

/** Lo que un mandato concreto hizo dentro de UN turno. */
export interface TurnDelegation {
  /** `mandates.label`, tal cual viajó pegado al resultado. */
  label: string;
  /** Ids de herramienta, sin repetir, en el orden en que se usaron. */
  toolIds: string[];
  /** Cuántas llamadas. Puede ser mayor que `toolIds.length`. */
  calls: number;
}

/**
 * Las delegaciones de un turno, agrupadas POR MANDATO (regla 1).
 *
 * Un turno con seis correos bajo la misma concesión sale como una entrada con
 * `calls: 6`, no como seis entradas.
 */
export function groupTurnDelegations(invocations: readonly InvocationLike[]): TurnDelegation[] {
  const byLabel = new Map<string, TurnDelegation>();
  for (const inv of invocations) {
    const label = delegatedByOf(inv.result);
    if (!label) continue;
    const entry = byLabel.get(label) ?? { label, toolIds: [], calls: 0 };
    entry.calls += 1;
    if (!entry.toolIds.includes(inv.toolName)) entry.toolIds.push(inv.toolName);
    byLabel.set(label, entry);
  }
  return [...byLabel.values()];
}

/**
 * Qué aviso se enseña entero y cuál en una línea (regla 2).
 *
 * Recibe los mensajes EN ORDEN y devuelve, por id de mensaje, la lista de
 * delegaciones con su forma. La primera aparición de cada mandato en la
 * conversación es `full`; las siguientes, `brief`.
 */
export type NoticeVariant = 'full' | 'brief';

export interface NoticePlanEntry extends TurnDelegation {
  variant: NoticeVariant;
}

export function planNotices(
  messages: readonly { id: string; invocations: readonly InvocationLike[] }[],
): Record<string, NoticePlanEntry[]> {
  const plan: Record<string, NoticePlanEntry[]> = {};
  const announced = new Set<string>();
  for (const message of messages) {
    const groups = groupTurnDelegations(message.invocations);
    if (groups.length === 0) continue;
    plan[message.id] = groups.map((g) => {
      const variant: NoticeVariant = announced.has(g.label) ? 'brief' : 'full';
      announced.add(g.label);
      return { ...g, variant };
    });
  }
  return plan;
}

/**
 * Lo que hizo, en una frase, en primera persona y sin adornos.
 *
 * Nombra la herramienta cuando fue una sola —que es el caso normal y el que se
 * entiende de un vistazo— y cuenta las cosas cuando fueron varias, porque
 * enumerar cinco nombres de herramienta en una línea no se lee.
 */
export function delegationHeadline(d: TurnDelegation): string {
  if (d.toolIds.length === 1 && d.toolIds[0]) {
    const tool = toolDisplayName(d.toolIds[0]).toLocaleLowerCase('es');
    return d.calls === 1
      ? `Usé «${tool}» sin preguntarte`
      : `Usé «${tool}» ${d.calls} veces sin preguntarte`;
  }
  return `Hice ${d.calls} cosas sin preguntarte, con ${d.toolIds.length} herramientas`;
}

// ---------------------------------------------------------------------------
// 2. La razón, compuesta de la fila
// ---------------------------------------------------------------------------

function bogotaYear(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', { year: 'numeric', timeZone: BOGOTA_TZ }).format(d);
}

/**
 * «3 de agosto», o «3 de agosto de 2025» cuando no es de este año.
 *
 * El año se omite en el año corriente porque una fecha con año en una frase
 * corta se lee como jurídica; se pone cuando lo hay, porque un permiso concedido
 * hace catorce meses tiene que declararlo.
 */
export function formatDay(iso: string, now: Date = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = bogotaYear(date) === bogotaYear(now);
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: BOGOTA_TZ,
  }).format(date);
}

/** Los campos de `mandates` de los que se compone la razón. Ninguno más. */
export interface MandateOrigin {
  /** `mandates.label`. */
  label: string;
  /** Nombre resuelto de `mandates.granted_by`, o null si ya no está. */
  grantedByName: string | null;
  /** Si quien mira es quien concedió. Decide entre «me autorizaste» y «autorizó». */
  grantedByIsViewer: boolean;
  /** `mandates.created_at`. */
  createdAt: string | null;
}

/**
 * «como me autorizaste el 3 de agosto», y null cuando no se puede decir con
 * verdad.
 *
 * Cada palabra sale de una columna: la fecha de `created_at`, la persona de
 * `granted_by`, y nada de aquí llama a ningún modelo. Sin `created_at` válido
 * devuelve null y el aviso se queda sin esa mitad, que es lo correcto: la razón
 * es lo que hace verificable el aviso, y una razón aproximada no lo es.
 */
export function authorizationPhrase(o: MandateOrigin, now: Date = new Date()): string | null {
  if (!o.createdAt) return null;
  const day = formatDay(o.createdAt, now);
  if (!day) return null;
  if (o.grantedByIsViewer) return `como me autorizaste el ${day}`;
  if (o.grantedByName) return `como me autorizó ${o.grantedByName} el ${day}`;
  // La fila existe y tiene fecha, pero el nombre no se pudo resolver — la
  // columna es `not null` con `on delete restrict`, así que esto es un fallo de
  // lectura, no una fila sin autor. Se dice lo que consta y no más.
  return `como me autorizaron el ${day}`;
}

// ---------------------------------------------------------------------------
// 3. Lo ejercido, tal y como lo devuelve la ruta
// ---------------------------------------------------------------------------

export type MandateStateName = 'active' | 'revoked' | 'expired' | 'scheduled';

/** Una concesión que actuó en esta conversación, con su origen y su estado. */
export interface ExercisedMandate extends MandateOrigin {
  mandateId: string;
  state: MandateStateName;
  /** Ids de herramienta que esta concesión usó en esta conversación. */
  toolIds: string[];
  /** Llamadas delegadas en esta conversación. */
  calls: number;
  /** La más reciente de ellas, ISO. */
  lastUsedAt: string | null;
}

function normalizeToolId(id: string): string {
  // `audit_events.tool_id` guarda el id con punto (`gmail.send_draft`); el SDK
  // de IA nombra la herramienta con guion bajo. Es el mismo id escrito de dos
  // maneras, y `TaskRows.matchDurations` ya normaliza igual.
  return id.replaceAll('.', '_');
}

/**
 * La concesión que corresponde a lo que este turno delegó, o null.
 *
 * Se casa por nombre Y por herramienta: el nombre es lo único que viaja pegado
 * al resultado, y dos concesiones pueden llamarse igual. Si tras cruzar las dos
 * cosas sigue habiendo más de una candidata, devuelve null y el aviso se enseña
 * sin fecha y sin botón — antes eso que ofrecer revocar la concesión equivocada.
 */
export function matchExercised(
  d: TurnDelegation,
  list: readonly ExercisedMandate[],
): ExercisedMandate | null {
  const sameLabel = list.filter((m) => m.label === d.label);
  if (sameLabel.length === 1) return sameLabel[0] ?? null;
  const wanted = new Set(d.toolIds.map(normalizeToolId));
  const overlapping = sameLabel.filter((m) =>
    m.toolIds.some((id) => wanted.has(normalizeToolId(id))),
  );
  return overlapping.length === 1 ? (overlapping[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// 4. El uso, agrupado para la pantalla del mandato
// ---------------------------------------------------------------------------

/** Una fila de `mandate_uses`, como la lee `listRecentUses`. */
export interface UseRowLike {
  mandate_id: string;
  tool_id: string;
  used_at: string;
  amount?: number | string | null;
  currency?: string | null;
}

export interface ToolUsage {
  toolId: string;
  label: string;
  calls: number;
  lastAt: string;
}

export interface MandateUsage {
  calls: number;
  lastUsedAt: string | null;
  /** Una fila por herramienta, de más usada a menos. Regla 3. */
  byTool: ToolUsage[];
  /** Lo que movió, por moneda. Nunca se suman monedas distintas. */
  money: { currency: string; total: number }[];
}

export const EMPTY_USAGE: MandateUsage = { calls: 0, lastUsedAt: null, byTool: [], money: [] };

/**
 * El uso de cada mandato, agrupado por herramienta.
 *
 * Las monedas se llevan por separado, como en `aggregateRecords`: sumar pesos
 * con dólares da un número que no existe, y este número acaba en una pantalla
 * donde alguien decide si un permiso sigue teniendo sentido.
 */
export function summarizeUses(uses: readonly UseRowLike[]): Record<string, MandateUsage> {
  const out: Record<string, MandateUsage> = {};
  const tools = new Map<string, Map<string, ToolUsage>>();
  const money = new Map<string, Map<string, number>>();

  for (const u of uses) {
    let usage = out[u.mandate_id];
    if (!usage) {
      usage = { calls: 0, lastUsedAt: null, byTool: [], money: [] };
      out[u.mandate_id] = usage;
    }
    usage.calls += 1;
    if (!usage.lastUsedAt || u.used_at > usage.lastUsedAt) usage.lastUsedAt = u.used_at;

    const perTool = tools.get(u.mandate_id) ?? new Map<string, ToolUsage>();
    const row = perTool.get(u.tool_id) ?? {
      toolId: u.tool_id,
      label: toolDisplayName(u.tool_id),
      calls: 0,
      lastAt: u.used_at,
    };
    row.calls += 1;
    if (u.used_at > row.lastAt) row.lastAt = u.used_at;
    perTool.set(u.tool_id, row);
    tools.set(u.mandate_id, perTool);

    const amount = typeof u.amount === 'string' ? Number(u.amount) : u.amount;
    if (u.currency && typeof amount === 'number' && Number.isFinite(amount)) {
      const perCurrency = money.get(u.mandate_id) ?? new Map<string, number>();
      perCurrency.set(u.currency, (perCurrency.get(u.currency) ?? 0) + amount);
      money.set(u.mandate_id, perCurrency);
    }
  }

  for (const [mandateId, usage] of Object.entries(out)) {
    usage.byTool = [...(tools.get(mandateId)?.values() ?? [])].sort(
      (a, b) => b.calls - a.calls || b.lastAt.localeCompare(a.lastAt),
    );
    usage.money = [...(money.get(mandateId)?.entries() ?? [])]
      .map(([currency, total]) => ({ currency, total }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }
  return out;
}

/** Días enteros entre dos instantes, hacia abajo y nunca negativo. */
export function daysSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Cuándo fue la última vez, o desde cuándo no lo es — dicho sin exagerar en
 * ninguna de las dos direcciones.
 *
 * `windowDays` es la ventana que se pudo mirar. Cuando la concesión es más
 * joven que la ventana, la ventana cubre TODA su vida y se puede decir «desde
 * que se concedió»; cuando es más vieja, lo único cierto es «en los últimos N
 * días», porque más atrás no se leyó nada. Esa distinción es la diferencia
 * entre un dato y una insinuación, y esta frase existe justamente para que un
 * mandato que nadie ejerce se note.
 */
export function lastUseSentence(input: {
  lastUsedAt: string | null;
  createdAt: string;
  windowDays: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  if (input.lastUsedAt) {
    const days = daysSince(input.lastUsedAt, now);
    if (days === 0) return 'La última vez fue hoy';
    if (days === 1) return 'La última vez fue ayer';
    return `La última vez fue hace ${days} días`;
  }
  const age = daysSince(input.createdAt, now);
  if (age <= input.windowDays) {
    return age === 0
      ? 'Todavía no lo ha ejercido: se concedió hoy'
      : `No lo ha ejercido ni una vez desde que se concedió, hace ${age} ${plural(age, 'día', 'días')}`;
  }
  return `No lo ha ejercido en los últimos ${input.windowDays} días`;
}
