import { BLOCK_LABEL, type ViewBlock } from '../views/spec';
import { type TablePermission, describeEdit, describeRead } from './permissions';
import { type Snapshot, diffSnapshots, stableStringify } from './versions-shape';

/**
 * COMPARAR DOS VERSIONES DE UNA APP, EN ESPAÑOL Y EN PURO.
 *
 * `diffSnapshots` (versions-shape.ts) da una frase por pantalla o rol: «2
 * bloques más», «Permisos del rol». Sirve para el historial; no alcanza para
 * decidir si se vuelve atrás. Aquí se baja un nivel: qué bloques se agregaron,
 * quitaron o cambiaron en cada pantalla (y qué campos pide cada formulario),
 * y qué permisos cambió cada rol, tabla por tabla.
 *
 * Lo que una versión NO guarda (y por eso no se compara): las automatizaciones
 * y los datos de las tablas. Las automatizaciones viven aparte de las
 * versiones; la comparación lo dice al final para no dar a entender que se
 * revisaron.
 */

export type CompareArea =
  | 'app'
  | 'screen'
  | 'block'
  | 'form'
  | 'role'
  | 'permission'
  | 'home'
  | 'look'
  | 'dashboards'
  | 'portal';

export interface CompareLine {
  kind: 'added' | 'removed' | 'changed';
  area: CompareArea;
  text: string;
}

export const COMPARE_NOT_VERSIONED =
  'Las automatizaciones y los datos de las tablas no forman parte de una versión: no se comparan ni se devuelven.';

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

const names = (xs: readonly string[]) => xs.map((x) => `«${x}»`).join(', ');

function blockName(b: ViewBlock): string {
  const t = (b as { title?: unknown }).title;
  const title = typeof t === 'string' && t.trim() ? ` «${t.trim()}»` : '';
  return `${BLOCK_LABEL[b.type].toLowerCase()}${title}`;
}

function listDelta(before: readonly string[], after: readonly string[]) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

/** Qué cambió dentro de UN bloque (con el mismo id en las dos versiones). */
function blockChanges(before: ViewBlock, after: ViewBlock): string[] {
  const out: string[] = [];
  if (before.type !== after.type) return [`pasó de ${blockName(before)} a ${blockName(after)}`];
  const get = (b: ViewBlock, k: string) => (b as unknown as Record<string, unknown>)[k];
  const arr = (b: ViewBlock, k: string): string[] => {
    const v = get(b, k);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  if (get(before, 'tracker') !== get(after, 'tracker'))
    out.push(`ahora lee «${String(get(after, 'tracker'))}» (antes «${String(get(before, 'tracker'))}»)`);
  const title = (b: ViewBlock) => String(get(b, 'title') ?? '');
  if (title(before) !== title(after))
    out.push(`título «${title(before)}» → «${title(after)}»`);
  for (const [key, label] of [
    ['fields', 'campos'],
    ['columns', 'columnas'],
    ['editable', 'columnas editables'],
  ] as const) {
    const d = listDelta(arr(before, key), arr(after, key));
    if (d.added.length) out.push(`${label} nuevos: ${names(d.added)}`);
    if (d.removed.length) out.push(`${label} quitados: ${names(d.removed)}`);
  }
  if (before.type === 'form' && after.type === 'form') {
    const linesOf = (b: typeof before) =>
      [b.lines, ...(b.moreLines ?? [])].flatMap((l) => (l ? [`«${l.title}»${l.amount ? ` con ${l.amountLabel ?? l.amount}` : ''}`] : []));
    if (!same(linesOf(before), linesOf(after))) {
      const d = listDelta(linesOf(before), linesOf(after));
      if (d.added.length) out.push(`listas de ítems nuevas: ${d.added.join(', ')}`);
      if (d.removed.length) out.push(`listas de ítems quitadas: ${d.removed.join(', ')}`);
      if (!d.added.length && !d.removed.length) out.push('listas de ítems ajustadas');
    }
    if (Boolean(before.onRecord) !== Boolean(after.onRecord))
      out.push(after.onRecord ? 'completa un registro que ya existe' : 'vuelve a ser un formulario de registro nuevo');
    if (before.submitLabel !== after.submitLabel)
      out.push(`botón «${before.submitLabel}» → «${after.submitLabel}»`);
    if (!same(before.approval, after.approval))
      out.push(after.approval ? 'aprobación configurada' : 'sin aprobación');
    if (!same(before.steps, after.steps))
      out.push(after.steps?.length ? `por pasos (${after.steps.length})` : 'ya no es por pasos');
  }
  if ('actions' in before && 'actions' in after) {
    const d = listDelta(
      before.actions.map((a) => a.label),
      after.actions.map((a) => a.label),
    );
    if (d.added.length) out.push(`botones nuevos: ${names(d.added)}`);
    if (d.removed.length) out.push(`botones quitados: ${names(d.removed)}`);
  }
  if (!same(get(before, 'filters'), get(after, 'filters'))) out.push('filtros');
  if (!out.length && !same(before, after)) out.push('ajustes de contenido o diseño');
  return out;
}

function screenChanges(
  before: Snapshot['screens'][number],
  after: Snapshot['screens'][number],
): CompareLine[] {
  const out: CompareLine[] = [];
  const who = (s: Snapshot['screens'][number]) => (s.roles.length ? names(s.roles) : 'todos');
  const label = `Pantalla «${after.title}»`;
  if (before.title !== after.title)
    out.push({
      kind: 'changed',
      area: 'screen',
      text: `${label}: título «${before.title}» → «${after.title}»`,
    });
  if (!same([...before.roles].sort(), [...after.roles].sort()))
    out.push({
      kind: 'changed',
      area: 'screen',
      text: `${label}: la ven ${who(after)} (antes ${who(before)})`,
    });
  const bb = new Map(before.spec.blocks.map((b) => [b.id, b]));
  const ab = new Map(after.spec.blocks.map((b) => [b.id, b]));
  for (const b of after.spec.blocks)
    if (!bb.has(b.id))
      out.push({ kind: 'added', area: 'block', text: `${label}: bloque nuevo, ${blockName(b)}` });
  for (const b of before.spec.blocks)
    if (!ab.has(b.id))
      out.push({ kind: 'removed', area: 'block', text: `${label}: bloque quitado, ${blockName(b)}` });
  for (const b of after.spec.blocks) {
    const prev = bb.get(b.id);
    if (!prev || same(prev, b)) continue;
    const bits = blockChanges(prev, b);
    if (bits.length)
      out.push({
        kind: 'changed',
        area: b.type === 'form' ? 'form' : 'block',
        text: `${label}, ${blockName(b)}: ${bits.join('; ')}`,
      });
  }
  const order = (s: Snapshot['screens'][number]) => s.spec.blocks.map((b) => b.id).join('|');
  if (
    order(before) !== order(after) &&
    before.spec.blocks.length === after.spec.blocks.length &&
    [...bb.keys()].every((k) => ab.has(k))
  )
    out.push({ kind: 'changed', area: 'block', text: `${label}: orden de los bloques` });
  if (
    !out.length &&
    !same(before.spec, after.spec) // alertas, páginas, tema, edición…
  )
    out.push({ kind: 'changed', area: 'screen', text: `${label}: ajustes generales de la pantalla` });
  return out;
}

function permissionLines(
  roleName: string,
  before: Snapshot['roles'][number]['permissions'],
  after: Snapshot['roles'][number]['permissions'],
): CompareLine[] {
  const out: CompareLine[] = [];
  const line = (kind: CompareLine['kind'], text: string) =>
    out.push({ kind, area: 'permission', text: `Rol «${roleName}»: ${text}` });
  const tables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const t of tables) {
    const b: TablePermission | undefined = before.tables[t];
    const a: TablePermission | undefined = after.tables[t];
    if (!b && a) {
      line('added', `ahora usa «${t}» (${describeRead(a.read).toLowerCase()}${a.create ? ', registra' : ''}${a.edit !== 'none' ? `, ${describeEdit(a.edit).toLowerCase()}` : ''})`);
      continue;
    }
    if (b && !a) {
      line('removed', `ya no ve «${t}»`);
      continue;
    }
    if (!a || !b || same(a, b)) continue;
    const bits: string[] = [];
    if (!same(a.read, b.read))
      bits.push(`${describeRead(a.read).toLowerCase()} (antes ${describeRead(b.read).toLowerCase()})`);
    if (a.create !== b.create) bits.push(a.create ? 'ahora puede registrar' : 'ya no puede registrar');
    if (a.edit !== b.edit)
      bits.push(`${describeEdit(a.edit).toLowerCase()} (antes ${describeEdit(b.edit).toLowerCase()})`);
    const fd = listDelta(b.fields ?? [], a.fields ?? []);
    if (!b.fields && a.fields) bits.push(`escribe sólo ${names(a.fields)}`);
    else if (b.fields && !a.fields) bits.push('escribe todos los campos del formulario');
    else {
      if (fd.added.length) bits.push(`puede escribir además ${names(fd.added)}`);
      if (fd.removed.length) bits.push(`ya no escribe ${names(fd.removed)}`);
    }
    const ad = listDelta(b.actions, a.actions);
    if (ad.added.length) bits.push(`botones nuevos: ${names(ad.added)}`);
    if (ad.removed.length) bits.push(`botones quitados: ${names(ad.removed)}`);
    line('changed', `en «${t}»: ${bits.join('; ')}`);
  }
  if (before.export !== after.export)
    line('changed', after.export ? 'ahora puede exportar' : 'ya no puede exportar');
  if ((before.kiosk ?? false) !== (after.kiosk ?? false))
    line('changed', after.kiosk ? 'ahora puede dejar un celular en modo kiosco' : 'ya no usa modo kiosco');
  if (!same(before.location ?? {}, after.location ?? {})) line('changed', 'permisos de ubicación del equipo');
  return out;
}

/**
 * Qué cambió de `before` a `after`, por pantalla, bloque, campo y permiso. Una
 * lista vacía = son iguales (en lo que una versión guarda).
 */
/** Lo que cambia en UNA pantalla (su spec y quién la ve): la comparación de una propuesta de Cortex. */
export function compareScreenSpecs(
  before: { title: string; roles: string[]; spec: Snapshot['screens'][number]['spec'] },
  after: { title: string; roles: string[]; spec: Snapshot['screens'][number]['spec'] },
): CompareLine[] {
  return screenChanges(
    before as Snapshot['screens'][number],
    after as Snapshot['screens'][number],
  );
}

export function compareSnapshots(before: Snapshot, after: Snapshot): CompareLine[] {
  const out: CompareLine[] = [];

  // Lo que no es pantalla ni rol, con las frases del historial.
  for (const c of diffSnapshots(before, after))
    if (c.area !== 'screen' && c.area !== 'role')
      out.push({ kind: c.kind, area: c.area as CompareArea, text: c.text });

  const bs = new Map(before.screens.map((s) => [s.slug, s]));
  const as = new Map(after.screens.map((s) => [s.slug, s]));
  for (const s of after.screens) {
    const prev = bs.get(s.slug);
    if (!prev)
      out.push({
        kind: 'added',
        area: 'screen',
        text: `Pantalla nueva «${s.title}»: ${s.spec.blocks.map(blockName).join(', ') || 'vacía'}`,
      });
    else out.push(...screenChanges(prev, s));
  }
  for (const s of before.screens)
    if (!as.has(s.slug))
      out.push({ kind: 'removed', area: 'screen', text: `Pantalla quitada «${s.title}»` });
  const order = (x: Snapshot) => x.screens.map((s) => s.slug).join('|');
  if (
    order(before) !== order(after) &&
    before.screens.length === after.screens.length &&
    [...bs.keys()].every((k) => as.has(k))
  )
    out.push({ kind: 'changed', area: 'screen', text: 'Orden de las pantallas' });

  const br = new Map(before.roles.map((r) => [r.key, r]));
  const ar = new Map(after.roles.map((r) => [r.key, r]));
  for (const r of after.roles) {
    const prev = br.get(r.key);
    if (!prev) {
      out.push({ kind: 'added', area: 'role', text: `Rol nuevo «${r.name}»` });
      out.push(...permissionLines(r.name, { tables: {}, export: false }, r.permissions));
      continue;
    }
    if (prev.name !== r.name)
      out.push({ kind: 'changed', area: 'role', text: `Rol «${prev.name}» → «${r.name}»` });
    out.push(...permissionLines(r.name, prev.permissions, r.permissions));
  }
  for (const r of before.roles)
    if (!ar.has(r.key)) out.push({ kind: 'removed', area: 'role', text: `Rol quitado «${r.name}»` });

  return out;
}

const KIND_LABEL = { added: 'Agregado', removed: 'Quitado', changed: 'Cambiado' } as const;

/** Las líneas como texto agrupado por tipo de cambio (chat y tarjetas). */
export function renderComparison(
  lines: readonly CompareLine[],
  heading: string,
  max = 60,
): string {
  if (!lines.length) return `${heading}\nSon iguales en pantallas, bloques, campos, permisos y apariencia.\n${COMPARE_NOT_VERSIONED}`;
  const parts: string[] = [heading];
  for (const kind of ['added', 'removed', 'changed'] as const) {
    const of = lines.filter((l) => l.kind === kind);
    if (!of.length) continue;
    parts.push(`${KIND_LABEL[kind]} (${of.length}):`);
    for (const l of of.slice(0, max)) parts.push(`- ${l.text}`);
    if (of.length > max) parts.push(`- y ${of.length - max} más`);
  }
  parts.push(COMPARE_NOT_VERSIONED);
  return parts.join('\n');
}
