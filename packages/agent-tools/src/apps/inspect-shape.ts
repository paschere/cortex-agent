import type { TrackerField } from '../trackers/schema';
import { type CatalogTracker, BLOCK_LABEL, type ViewBlock, type ViewSpec, trackersOf } from '../views/spec';
import {
  type AppPermissions,
  type ResolvedRole,
  adminRole,
  canCreateIn,
  canSeeScreen,
  editAccessFor,
  requiredAttributes,
  rowAccessFor,
  writableFieldsFor,
} from './permissions';

/**
 * «QUÉ VE DE VERDAD ESTE ROL»: LA REVISIÓN DE UNA APP, EN PURO.
 *
 * Nació de un fallo real (2026-10-19): Cortex dijo «listo» tras cambiar una app
 * y en producción el selector de un formulario no aparecía para el rol
 * Operario. Nadie había mirado la app con los ojos de ese rol.
 *
 * `inspectApp` calcula, SIN navegador y sin tocar la base, lo que un rol ve de
 * una app: sus pantallas, los bloques de cada una, y por cada formulario cada
 * campo con el control que de verdad se le pinta (texto, número, desplegable
 * con N opciones, relación, fórmula de sólo lectura, lookup, autofill, fecha,
 * foto…). Y la lista de problemas que se detectan cruzando spec + permisos +
 * esquema real: es la misma lógica de permisos que usa la app (permissions.ts),
 * no una copia.
 *
 * Lo único que viene de fuera de este archivo son los datos (`InspectInput`):
 * `inspect.ts` los lee de la base; las pruebas los escriben a mano.
 */

export interface InspectScreen {
  slug: string;
  title: string;
  /** Roles que la ven; vacío = todos. */
  roles: string[];
  spec: ViewSpec;
}

export interface InspectRole {
  key: string;
  name: string;
  permissions: AppPermissions;
}

export interface InspectInput {
  app: { name: string; homeScreen: string | null };
  screens: InspectScreen[];
  roles: InspectRole[];
  /** Esquema real de las tablas (y fuentes) que las pantallas nombran. */
  catalog: readonly CatalogTracker[];
  /** Filas que tiene cada tabla hoy (todas; sin filtro de rol). Ausente = no se contó. */
  rowCounts?: Readonly<Record<string, number>>;
  /** El rol a revisar; null o «administrador» = quien administra (ve todo). */
  roleKey: string | null;
}

export type ControlKind =
  | 'text'
  | 'longtext'
  | 'number'
  | 'percent'
  | 'money'
  | 'date'
  | 'time'
  | 'select'
  | 'checkbox'
  | 'photo'
  | 'signature'
  | 'file'
  | 'location'
  | 'relation'
  | 'scan'
  | 'formula'
  | 'lookup'
  | 'unknown';

export interface InspectField {
  key: string;
  label: string;
  /** El control que se pinta, en una frase: «desplegable (4 opciones)». */
  control: string;
  kind: ControlKind;
  required: boolean;
  /** La persona de este rol puede escribirlo. false = sólo lectura o fuera de sus permisos. */
  writable: boolean;
  /** Pasos del formulario por pasos (título), si lo hay. */
  step?: string;
  /** Notas sueltas: condicional, autofill, lookup… */
  notes: string[];
  /** Opciones que carga un desplegable o una relación; null = no aplica o no se sabe. */
  options: number | null;
}

export interface InspectBlock {
  id: string;
  type: ViewBlock['type'];
  label: string;
  title: string | null;
  source: string | null;
  sourceName: string | null;
  /** Qué filas de la fuente ve el rol: «todas», «las suyas», «filtradas por Cliente» o «ninguna». */
  rows: 'all' | 'own' | 'filtered' | 'none' | null;
  /** Filas que tiene la tabla hoy (no filtradas por rol). */
  rowCount: number | null;
  canCreate: boolean;
  edit: 'none' | 'own' | 'all' | null;
  /** Sólo en formularios. */
  fields?: InspectField[];
  issues: string[];
}

export interface InspectScreenReport {
  slug: string;
  title: string;
  blocks: InspectBlock[];
}

export interface InspectReport {
  app: string;
  role: { key: string; name: string; admin: boolean };
  /** Para un rol con filtro por atributo («Cliente»): qué atributos hay que dar al invitar. */
  needsAttributes: string[];
  screens: InspectScreenReport[];
  /** Pantallas del spec que este rol no ve. */
  hiddenScreens: string[];
  /** La pantalla que abre primero (o null si no ve ninguna). */
  startScreen: string | null;
  problems: string[];
}

function resolveRole(input: InspectInput): ResolvedRole | null {
  if (!input.roleKey || input.roleKey === 'administrador') return adminRole();
  const r = input.roles.find((x) => x.key === input.roleKey);
  if (!r) return null;
  return { key: r.key, name: r.name, permissions: r.permissions, admin: false };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Los campos que un formulario pide, con el paso al que pertenecen. */
function formFieldKeys(
  block: Extract<ViewBlock, { type: 'form' }>,
  tracker: CatalogTracker,
): Array<{ key: string; step?: string }> {
  if (block.steps?.length)
    return block.steps.flatMap((s) => s.fields.map((key) => ({ key, step: s.title })));
  const keys = block.fields.length ? block.fields : tracker.fields.map((f) => f.key);
  return keys.map((key) => ({ key }));
}

interface FormContext {
  role: ResolvedRole;
  spec: ViewSpec;
  catalog: ReadonlyMap<string, CatalogTracker>;
  rowCounts: Readonly<Record<string, number>>;
  tracker: CatalogTracker;
}

/** El control efectivo de un campo (lo que el formulario pinta para este rol). */
export function describeControl(
  f: TrackerField,
  ctx: Pick<FormContext, 'role' | 'spec' | 'catalog' | 'rowCounts'> & { asked?: ReadonlySet<string> },
): { control: string; kind: ControlKind; options: number | null; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (f.formula)
    return {
      control: 'fórmula (se calcula sola, solo lectura)',
      kind: 'formula',
      options: null,
      problems,
      notes: [`fórmula: ${f.formula}`],
    };
  if (f.lookup) {
    const via = f.lookup.via;
    const viaAsked = ctx.asked ? ctx.asked.has(via) : true;
    if (!viaAsked)
      problems.push(
        `«${f.label}» se trae de «${via}» pero el formulario no pide ese campo: quedará vacío.`,
      );
    return {
      control: f.lookup.editable
        ? `traído de otra tabla al elegir «${via}» (se puede corregir)`
        : `traído de otra tabla al elegir «${via}» (solo lectura)`,
      kind: 'lookup',
      options: null,
      problems,
      notes,
    };
  }
  switch (f.type) {
    case 'select': {
      const n = (f.flow?.states ?? f.options ?? []).length;
      if (n === 0) problems.push(`El desplegable «${f.label}» no tiene opciones.`);
      return {
        control: `desplegable (${plural(n, 'opción', 'opciones')})`,
        kind: 'select',
        options: n,
        problems,
        notes,
      };
    }
    case 'relation': {
      const target = f.tracker ? ctx.catalog.get(f.tracker) : undefined;
      const targetName = target?.name ?? f.tracker ?? '?';
      if (!target) {
        problems.push(`«${f.label}» apunta a la tabla «${f.tracker}», que ya no existe.`);
        return { control: 'relación (la tabla no existe)', kind: 'relation', options: 0, problems, notes };
      }
      // La ruta de opciones (/api/apps/.../relation) deja leer sólo las tablas que la
      // pantalla ya comparte cuando quien mira no es administrador.
      if (!ctx.role.admin && !trackersOf(ctx.spec).includes(target.slug)) {
        problems.push(
          `«${f.label}» es una relación a «${targetName}» y para el rol ${ctx.role.name} el desplegable no cargará opciones: esta pantalla no comparte esa tabla (agrega un bloque sobre «${targetName}» en la pantalla o muestra el campo de otra forma).`,
        );
        return {
          control: `relación a «${targetName}» (SIN opciones para este rol)`,
          kind: 'relation',
          options: 0,
          problems,
          notes,
        };
      }
      const total = ctx.rowCounts[target.slug];
      if (total === 0)
        problems.push(`«${f.label}» es una relación a «${targetName}», que no tiene registros: no habrá nada que elegir.`);
      return {
        control: `relación a «${targetName}»${total === undefined ? '' : ` (${plural(Math.min(total, 400), 'opción', 'opciones')}${total > 400 ? ', con búsqueda' : ''})`}`,
        kind: 'relation',
        options: total === undefined ? null : Math.min(total, 400),
        problems,
        notes,
      };
    }
    case 'file':
      return {
        control: f.accept === 'signature' ? 'firma dibujada' : f.accept === 'any' ? 'archivo' : 'foto',
        kind: f.accept === 'signature' ? 'signature' : f.accept === 'any' ? 'file' : 'photo',
        options: null,
        problems,
        notes: [
          ...(f.multiple ? ['varios archivos'] : []),
          ...(f.evidence ? ['con fecha, hora y GPS'] : []),
        ],
      };
    case 'number':
      return {
        control: f.percent ? 'porcentaje' : 'número',
        kind: f.percent ? 'percent' : 'number',
        options: null,
        problems,
        notes,
      };
    case 'money':
      return { control: 'dinero', kind: 'money', options: null, problems, notes };
    case 'date':
      return { control: 'fecha', kind: 'date', options: null, problems, notes };
    case 'time':
      return { control: 'hora', kind: 'time', options: null, problems, notes };
    case 'checkbox':
      return { control: 'casilla sí/no', kind: 'checkbox', options: null, problems, notes };
    case 'location':
      return { control: 'ubicación (GPS)', kind: 'location', options: null, problems, notes };
    case 'longtext':
      return {
        control: f.scan ? 'texto largo con lector de códigos' : 'texto largo',
        kind: f.scan ? 'scan' : 'longtext',
        options: null,
        problems,
        notes,
      };
    default:
      return {
        control: f.scan ? 'texto con lector de códigos' : f.format ? `texto (${f.format})` : 'texto',
        kind: f.scan ? 'scan' : 'text',
        options: null,
        problems,
        notes,
      };
  }
}

function inspectForm(
  block: Extract<ViewBlock, { type: 'form' }>,
  ctx: FormContext,
): { fields: InspectField[]; issues: string[] } {
  const issues: string[] = [];
  const entries = formFieldKeys(block, ctx.tracker);
  const asked = new Set(entries.map((e) => e.key));
  const whitelist = writableFieldsFor(ctx.role, ctx.tracker.slug);
  const autofillTargets = new Map<string, string>();
  for (const f of ctx.tracker.fields)
    for (const t of f.autofill?.fills ?? []) autofillTargets.set(t, f.label);

  if (!canCreateIn(ctx.role, ctx.tracker.slug))
    issues.push(
      `El rol ${ctx.role.name} no puede crear registros en «${ctx.tracker.name}»: el formulario se verá pero al enviar dirá que su rol no registra en esta tabla (activa «crear» para esa tabla en sus permisos).`,
    );

  const fields: InspectField[] = [];
  for (const { key, step } of entries) {
    const f = ctx.tracker.fields.find((x) => x.key === key);
    if (!f) {
      issues.push(`El formulario pide el campo «${key}», que no existe en «${ctx.tracker.name}».`);
      continue;
    }
    const d = describeControl(f, { ...ctx, asked });
    const notes = [...d.notes];
    const computed = d.kind === 'formula' || (d.kind === 'lookup' && !f.lookup?.editable);
    if (f.showIf)
      notes.push(
        f.showIf.notEmpty
          ? `solo aparece si «${f.showIf.field}» tiene algo`
          : `solo aparece si «${f.showIf.field}» es ${[f.showIf.equals].flat().join(' o ')}`,
      );
    const filler = autofillTargets.get(key);
    if (filler) notes.push(`Cortex puede proponerlo al completar «${filler}» (autofill)`);
    if (f.autofill) notes.push('al completarse, Cortex propone otros campos (autofill)');
    if (f.default !== undefined && f.default !== '') notes.push(`por defecto: ${String(f.default)}`);
    const roleCanWrite = !whitelist || whitelist.has(key);
    const writable = !computed && roleCanWrite;
    if (!computed && !roleCanWrite) {
      if (f.required && (f.default === undefined || f.default === ''))
        issues.push(
          `«${f.label}» es obligatorio pero el rol ${ctx.role.name} no puede escribirlo: nadie de ese rol podrá enviar el formulario (agrégalo a los campos que puede escribir o quítalo del formulario).`,
        );
      else
        issues.push(
          `«${f.label}» se muestra en el formulario pero el rol ${ctx.role.name} no puede escribirlo: dará error si lo llena.`,
        );
    }
    issues.push(...d.problems);
    fields.push({
      key,
      label: f.label,
      control: d.control,
      kind: d.kind,
      required: f.required && !computed,
      writable,
      ...(step ? { step } : {}),
      notes,
      options: d.options,
    });
  }
  // Un lookup o autofill cuyo origen no está en el formulario.
  for (const f of ctx.tracker.fields) {
    if (!asked.has(f.key) || !f.autofill) continue;
    for (const from of f.autofill.from)
      if (!asked.has(from))
        issues.push(
          `El autofill de «${f.label}» espera «${from}», que este formulario no pide: no se disparará.`,
        );
  }
  if (!fields.some((f) => f.writable))
    issues.push(`Ningún campo de este formulario es escribible por el rol ${ctx.role.name}.`);
  return { fields, issues };
}

function rowsKind(access: ReturnType<typeof rowAccessFor>): InspectBlock['rows'] {
  switch (access.kind) {
    case 'all':
      return 'all';
    case 'own':
      return 'own';
    case 'equals':
      return 'filtered';
    case 'none':
      return 'none';
  }
}

function blockTitle(b: ViewBlock): string | null {
  const t = (b as { title?: unknown }).title;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** Los bloques de una pantalla vistos por un rol. */
function inspectScreen(
  screen: InspectScreen,
  role: ResolvedRole,
  catalog: ReadonlyMap<string, CatalogTracker>,
  rowCounts: Readonly<Record<string, number>>,
  problems: string[],
): InspectScreenReport {
  const user = { id: 'inspect', name: 'inspect', attributes: {} };
  const blocks: InspectBlock[] = [];
  for (const b of screen.spec.blocks) {
    const source = 'tracker' in b ? b.tracker : null;
    const tracker = source ? catalog.get(source) : undefined;
    const issues: string[] = [];
    const access = source ? rowAccessFor(role, user, source) : null;
    const rows = access ? rowsKind(access) : null;
    const count = source ? (rowCounts[source] ?? null) : null;
    const isRowBlock = b.type !== 'text' && b.type !== 'media' && b.type !== 'links' && b.type !== 'voice';
    if (source && !tracker && !source.includes('.'))
      issues.push(`La tabla «${source}» de este bloque ya no existe.`);
    // Un formulario sobre una tabla que el rol no lee SÍ funciona si puede crear: no es lo mismo que leer.
    if (source && rows === 'none' && b.type !== 'form' && isRowBlock)
      issues.push(
        `El rol ${role.name} no tiene permiso sobre «${tracker?.name ?? source}»: este bloque saldrá como aviso, no como datos.`,
      );
    if (source && rows !== 'none' && count === 0 && b.type !== 'form' && isRowBlock)
      issues.push(`«${tracker?.name ?? source}» no tiene registros todavía: el bloque saldrá vacío.`);
    if (b.type === 'form' && tracker && source) {
      const { fields, issues: formIssues } = inspectForm(b, {
        role,
        spec: screen.spec,
        catalog,
        rowCounts,
        tracker,
      });
      issues.push(...formIssues);
      blocks.push({
        id: b.id,
        type: b.type,
        label: BLOCK_LABEL[b.type],
        title: blockTitle(b),
        source,
        sourceName: tracker.name,
        rows,
        rowCount: count,
        canCreate: canCreateIn(role, source),
        edit: editAccessFor(role, source),
        fields,
        issues,
      });
    } else {
      // Columnas editables en la tabla que el rol no puede escribir.
      if (b.type === 'table' && source && b.editable.length && editAccessFor(role, source) === 'none')
        issues.push(
          `La tabla deja editar ${b.editable.join(', ')} pero el rol ${role.name} no edita «${tracker?.name ?? source}»: las celdas no serán editables.`,
        );
      if (source && 'actions' in b && b.actions.length) {
        const wl = role.admin ? null : role.permissions.tables[source]?.actions;
        const missing = b.actions.filter((a) => wl && !wl.includes(a.id));
        if (!role.admin && rows !== 'none' && missing.length === b.actions.length)
          issues.push(
            `Los botones (${missing.map((a) => a.label).join(', ')}) no están permitidos para el rol ${role.name}: no los verá.`,
          );
      }
      blocks.push({
        id: b.id,
        type: b.type,
        label: BLOCK_LABEL[b.type],
        title: blockTitle(b),
        source,
        sourceName: tracker?.name ?? null,
        rows,
        rowCount: count,
        canCreate: source ? canCreateIn(role, source) : false,
        edit: source ? editAccessFor(role, source) : null,
        issues,
      });
    }
  }
  for (const blk of blocks)
    for (const i of blk.issues)
      problems.push(`«${screen.title}» · ${blk.title ?? blk.label}: ${i}`);
  return { slug: screen.slug, title: screen.title, blocks };
}

export function inspectApp(input: InspectInput): InspectReport | { error: string } {
  const role = resolveRole(input);
  if (!role)
    return {
      error: `La app no tiene un rol «${input.roleKey}». Roles: ${input.roles.map((r) => r.key).join(', ') || 'ninguno'}.`,
    };
  const catalog = new Map(input.catalog.map((c) => [c.slug, c]));
  const rowCounts = input.rowCounts ?? {};
  const problems: string[] = [];
  const visible = input.screens.filter((s) => canSeeScreen(role, s.roles));
  const hidden = input.screens.filter((s) => !canSeeScreen(role, s.roles)).map((s) => s.title);
  const screens = visible.map((s) => inspectScreen(s, role, catalog, rowCounts, problems));

  // La pantalla de entrada: la elegida si el rol la ve; si no, la primera que ve.
  const wanted = input.app.homeScreen;
  const start =
    visible.find((s) => s.slug === wanted) ?? visible[0] ?? null;
  if (!visible.length)
    problems.push(
      `El rol ${role.name} no ve ninguna pantalla: al entrar no hay nada que abrir (revisa a quién va dirigida cada pantalla).`,
    );
  else if (wanted) {
    const home = input.screens.find((s) => s.slug === wanted);
    if (home && !canSeeScreen(role, home.roles))
      problems.push(
        `La pantalla de entrada «${home.title}» no es visible para el rol ${role.name}: abrirá «${start?.title}» en su lugar.`,
      );
    else if (!home)
      problems.push(`La pantalla de entrada «${wanted}» no existe: se abre la primera.`);
  }
  // Una pantalla inicial que sólo muestra avisos de permiso es una app rota para ese rol.
  if (start) {
    const startReport = screens.find((s) => s.slug === start.slug);
    if (
      startReport?.blocks.some((b) => b.source) &&
      startReport.blocks
        .filter((b) => b.source)
        .every((b) => b.rows === 'none' && !(b.type === 'form' && b.canCreate))
    )
      problems.push(
        `La pantalla inicial «${start.title}» no muestra nada útil al rol ${role.name}: todos sus bloques son de tablas sin permiso.`,
      );
  }

  return {
    app: input.app.name,
    role: { key: role.key, name: role.name, admin: role.admin },
    needsAttributes: role.admin ? [] : requiredAttributes(role.permissions),
    screens,
    hiddenScreens: hidden,
    startScreen: start?.slug ?? null,
    problems,
  };
}

const ROWS_TEXT: Record<NonNullable<InspectBlock['rows']>, string> = {
  all: 've todas las filas',
  own: 've sólo lo que registró',
  filtered: 've las filas de su atributo',
  none: 'SIN permiso',
};

/** El informe como texto para el modelo y para la tarjeta del chat. */
export function renderInspection(report: InspectReport): string {
  const lines: string[] = [];
  lines.push(
    `**${report.app}** vista como **${report.role.name}**${report.role.admin ? ' (todo)' : ''}. Abre en: ${report.startScreen ?? 'nada (no ve pantallas)'}.`,
  );
  if (report.needsAttributes.length)
    lines.push(`Al invitar a alguien con este rol hay que darle: ${report.needsAttributes.join(', ')}.`);
  for (const s of report.screens) {
    lines.push(`\n**Pantalla «${s.title}»** (${s.slug})`);
    for (const b of s.blocks) {
      const where = b.source
        ? ` · «${b.sourceName ?? b.source}»: ${b.rows ? ROWS_TEXT[b.rows] : ''}${b.rowCount !== null ? ` (${b.rowCount} en la tabla)` : ''}${b.edit && b.edit !== 'none' ? ` · edita ${b.edit === 'own' ? 'lo suyo' : 'todo'}` : ''}${b.type === 'form' ? (b.canCreate ? ' · puede registrar' : ' · NO puede registrar') : ''}`
        : '';
      lines.push(`- ${b.label}${b.title ? ` «${b.title}»` : ''}${where}`);
      for (const f of b.fields ?? [])
        lines.push(
          `  - ${f.label}${f.required ? ' *' : ''}${f.step ? ` [${f.step}]` : ''}: ${f.control}${f.writable ? '' : ' · no lo escribe'}${f.notes.length ? ` (${f.notes.join('; ')})` : ''}`,
        );
    }
  }
  if (report.hiddenScreens.length)
    lines.push(`\nPantallas que este rol NO ve: ${report.hiddenScreens.join(', ')}.`);
  lines.push(
    report.problems.length
      ? `\n**Problemas (${report.problems.length}):**\n${report.problems.map((p) => `- ${p}`).join('\n')}`
      : '\nSin problemas detectados para este rol.',
  );
  return lines.join('\n');
}

/**
 * ¿Lo pedido aparece? Revisa que cada campo (por clave o etiqueta, sin tildes ni
 * mayúsculas) esté entre los controles que el rol ve, escribible. Es lo que
 * Cortex usa para decir «listo» solo si lo que la persona pidió está de verdad.
 */
export function expectedFieldsMissing(
  report: InspectReport,
  expected: readonly string[],
): string[] {
  const fold = (t: string) =>
    t
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();
  const seen = new Set<string>();
  for (const s of report.screens)
    for (const b of s.blocks)
      for (const f of b.fields ?? []) {
        // Una relación sin opciones no «aparece» de verdad.
        if (f.kind === 'relation' && f.options === 0) continue;
        seen.add(fold(f.key));
        seen.add(fold(f.label));
      }
  return expected.filter((e) => !seen.has(fold(e)));
}
