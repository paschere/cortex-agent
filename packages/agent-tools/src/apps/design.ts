import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { trackerFieldsSchema, trackerSlugSchema } from '../trackers/schema';
import { getTrackerBySlug } from '../trackers/store';
import { internalSourcesOf } from '../views/sources';
import {
  APPROVE_ACTION_ID,
  type CatalogTracker,
  REJECT_ACTION_ID,
  type ViewSpec,
  checkSpecAgainst,
  slugify,
  trackersOf,
  viewSpecSchema,
} from '../views/spec';
import { validateSpec } from '../views/store';
import { SPEC_GRAMMAR } from '../views/tools';
import { type DesignNote, designNoteLines, reviewAppDesign } from './design-review';
import { normalizeAppIcon } from './icon-names';
import {
  type AppPermissions,
  USER_ATTRIBUTE_RE,
  describeEdit,
  describeRead,
  requiredAttributes,
  roleKeySchema,
} from './permissions';
import {
  PATTERN_IDS,
  type PatternTable,
  buildScreenFromPattern,
  describePatterns,
} from './screen-patterns';
import { MAX_APP_ROLES, MAX_APP_SCREENS, roleInputSchema } from './store';
import { APP_TEMPLATES } from './templates';

/**
 * APPS.DESIGN: ARMAR UNA APLICACIÓN COMPLETA DESDE UNA DESCRIPCIÓN, SIN GUARDAR
 * NADA (fase 4).
 *
 * Es el equivalente, para una app, de /api/views/design: la persona dice «hazme
 * un portal para mis clientes» y recibe un BORRADOR para aprobar —roles,
 * permisos en lenguaje simple, pantallas con specs válidos y automatizaciones
 * sugeridas— ANTES de que exista una sola tabla, pantalla o rol. Cuando la
 * persona dice que sí, `apps.create` guarda ese mismo borrador.
 *
 * QUIÉN PONE EL DISEÑO. El modelo del chat ya sabe armar el JSON (la gramática
 * de pantallas, roles y permisos va en la descripción de la herramienta, como en
 * apps.create); aquí no se llama a otro modelo. Lo que hace esta herramienta es
 * lo que el modelo no puede garantizar solo: validar cada pantalla contra las
 * tablas REALES de la empresa, cruzar roles y pantallas, avisar de lo que se
 * vería raro y devolver el borrador normalizado y un resumen que se le muestra a
 * la persona. Si algo no cuadra devuelve los problemas (no escribe, no lanza):
 * el modelo corrige y vuelve a llamarla.
 *
 * REGLA DE SIEMPRE: si la fuente es una hoja o una carpeta de Drive, primero se
 * propone la tabla (trackers.propose_from_source /
 * trackers.propose_from_drive_folder). Una pantalla sobre una tabla que no
 * existe sale como problema con esa instrucción.
 */

const screenDraft = z.object({
  title: z.string().trim().min(1).max(60),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,47}$/)
    .optional(),
  icon: z.string().trim().max(60).optional(),
  roles: z.array(roleKeySchema).max(MAX_APP_ROLES).default([]),
  spec: viewSpecSchema,
});

/** Una tabla que el borrador crea junto con la app (si no existe ya). */
export const tableDraftSchema = z.object({
  slug: trackerSlugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  fields: trackerFieldsSchema,
});
export type TableDraft = z.infer<typeof tableDraftSchema>;

export const appDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  icon: z.string().trim().max(400).optional(),
  roles: z.array(roleInputSchema).min(1).max(MAX_APP_ROLES),
  screens: z.array(screenDraft).min(1).max(MAX_APP_SCREENS),
  homeScreen: z.string().trim().max(48).optional(),
  /** Tablas nuevas que se crean con la app; una que ya existe se usa tal cual, sin tocarla. */
  tables: z.array(tableDraftSchema).max(8).default([]),
});
export type AppDraft = z.infer<typeof appDraftSchema>;

const automationIdea = z.object({
  name: z.string().trim().min(1).max(80),
  when: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(300),
});
export type AutomationIdea = z.infer<typeof automationIdea>;

export interface DraftReview {
  /** Hay problemas que impiden guardar: el modelo los corrige y vuelve a llamar. */
  ok: boolean;
  problems: string[];
  /** Cosas que no impiden guardar pero conviene que la persona sepa. */
  warnings: string[];
  /** El borrador normalizado, con la misma forma de entrada de `apps.create`. */
  draft: AppDraft | null;
  automations: AutomationIdea[];
  markdown: string;
}

type TrackerFields = Map<string, Set<string>>;

/**
 * Los campos de cada tabla propia que el borrador nombra y las que no existen.
 * `willCreate`: tablas que la plantilla crea al instalarse; mientras no existan
 * se usan sus campos y no cuentan como faltantes.
 */
async function loadFields(
  db: SupabaseClient,
  slugs: string[],
  willCreate: Map<string, string[]>,
): Promise<{
  found: Map<string, Set<string>>;
  missing: Set<string>;
  pending: Set<string>;
  catalog: Map<string, CatalogTracker>;
}> {
  const catalog = new Map<string, CatalogTracker>();
  const found = new Map<string, Set<string>>();
  const missing = new Set<string>();
  const pending = new Set<string>();
  for (const slug of slugs) {
    // Las fuentes de la plataforma (`cortex.*`) y del Feed no son tablas propias:
    // las comprueba `validateSpec` contra su catálogo.
    if (slug.includes('.')) continue;
    const tracker = await getTrackerBySlug(db, slug);
    if (tracker) {
      found.set(slug, new Set(tracker.fields.map((f) => f.key)));
      catalog.set(slug, { slug, name: tracker.name, fields: tracker.fields });
    } else if (willCreate.has(slug)) {
      found.set(slug, new Set(willCreate.get(slug)));
      pending.add(slug);
    } else missing.add(slug);
  }
  return { found, missing, pending, catalog };
}

function blockLabel(spec: ViewSpec): string {
  const counts = new Map<string, number>();
  for (const b of spec.blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${n} ${t}` : t)).join(', ');
}

/** Sugerencias de automatización que se deducen del diseño (la persona/Cortex las activa aparte). */
function deduceAutomations(draft: AppDraft): AutomationIdea[] {
  const out: AutomationIdea[] = [];
  const approvals = draft.screens.flatMap((s) =>
    s.spec.blocks.flatMap((b) => (b.type === 'form' && b.approval ? [b] : [])),
  );
  const approver = draft.roles.find((r) =>
    Object.values(r.permissions.tables).some(
      (t) => t.actions.includes(APPROVE_ACTION_ID) && t.actions.includes(REJECT_ACTION_ID),
    ),
  );
  for (const form of approvals) {
    out.push({
      name: 'Avisar si le rechazan una guía',
      when: `Una fila de «${form.tracker}» pasa a «${form.approval?.rejected}»`,
      action: 'Avisar por notificación o correo a quien la registró',
    });
    if (approver)
      out.push({
        name: 'Avisar al revisor cuando llegue algo por aprobar',
        when: `Se envía un formulario de «${form.tracker}»`,
        action: `Avisar al rol «${approver.name}» por notificación o correo`,
      });
    break;
  }
  const attrRole = draft.roles.find((r) => requiredAttributes(r.permissions).length);
  if (attrRole)
    out.push({
      name: 'Avisar al equipo de una solicitud nueva',
      when: 'Un cliente envía una solicitud',
      action: 'Avisar a los miembros que atienden por la campana o por correo',
    });
  return out;
}

/** Valida el borrador contra las tablas reales y lo cruza consigo mismo. No escribe. */
export async function reviewAppDraft(
  db: SupabaseClient,
  raw: unknown,
  options: {
    viewerId?: string | null;
    automations?: AutomationIdea[];
    /** Tablas que `apps.create` crea con la plantilla si aún no existen: slug → claves de campo. */
    willCreate?: Map<string, string[]>;
  } = {},
): Promise<DraftReview> {
  const parsed = appDraftSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || 'borrador'}: ${i.message}`),
      warnings: [],
      draft: null,
      automations: options.automations ?? [],
      markdown: '',
    };
  const problems: string[] = [];
  const warnings: string[] = [];

  // Claves únicas y pantallas con su slug (el que el modelo no dio sale del título).
  const roleKeys = new Set<string>();
  for (const r of parsed.data.roles) {
    if (r.key === 'administrador')
      problems.push('«administrador» es el rol de quien administra la empresa: no se define.');
    if (roleKeys.has(r.key)) problems.push(`El rol «${r.key}» está repetido.`);
    roleKeys.add(r.key);
  }
  const used = new Set<string>();
  const screens = parsed.data.screens.map((s, i) => {
    let slug = s.slug ?? (slugify(s.title) || `pantalla_${i + 1}`);
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(slug)) slug = `pantalla_${i + 1}`;
    while (used.has(slug)) slug = `${slug.slice(0, 44)}_${i + 1}`;
    used.add(slug);
    return { ...s, slug, icon: normalizeAppIcon(s.icon) };
  });
  const homeScreen = parsed.data.homeScreen ?? screens[0]?.slug;
  if (homeScreen && !screens.some((s) => s.slug === homeScreen))
    problems.push(`La pantalla de inicio «${homeScreen}» no está entre las pantallas.`);
  for (const s of screens)
    for (const r of s.roles)
      if (!roleKeys.has(r))
        problems.push(`La pantalla «${s.title}» nombra el rol «${r}», que no existe.`);

  // Cada pantalla contra las tablas reales. La de una tabla que falta lleva la regla de siempre.
  const allTables = [...new Set(screens.flatMap((s) => trackersOf(s.spec)))];
  // Las tablas que el borrador crea junto con la app: las que ya existen se usan tal cual.
  const willCreate = new Map(options.willCreate ?? []);
  const draftTables = new Map<string, (typeof parsed.data.tables)[number]>();
  for (const t of parsed.data.tables) {
    if (draftTables.has(t.slug))
      problems.push(`La tabla «${t.slug}» está repetida en el borrador.`);
    draftTables.set(t.slug, t);
    const existing = await getTrackerBySlug(db, t.slug);
    if (existing) {
      const have = new Set(existing.fields.map((f) => f.key));
      const lacking = t.fields.filter((f) => !have.has(f.key)).map((f) => f.key);
      warnings.push(
        `La tabla «${t.slug}» ya existe y se usa como está${lacking.length ? ` (no tiene ${lacking.map((k) => `«${k}»`).join(', ')}: agrégalos aparte con trackers.define)` : ''}.`,
      );
    } else
      willCreate.set(
        t.slug,
        t.fields.map((f) => f.key),
      );
  }
  const {
    found: tableFields,
    missing,
    pending,
    catalog,
  } = await loadFields(db, allTables, willCreate);
  const pendingCatalog: CatalogTracker[] = [...pending].flatMap((slug) => {
    const t = draftTables.get(slug);
    return t ? [{ slug, name: t.name, fields: t.fields }] : [];
  });
  if (missing.size)
    problems.push(
      `No existe la tabla ${[...missing].map((m) => `«${m}»`).join(', ')}. Si los datos están en una hoja de cálculo o una carpeta de Drive, primero propón la tabla con trackers.propose_from_source o trackers.propose_from_drive_folder (o trackers.define) y espera el visto bueno; después vuelve a diseñar la app sobre ella.`,
    );
  for (const s of screens) {
    // Una tabla que falta ya se reportó. Una que el borrador crea se comprueba contra su propia definición.
    const usedTables = trackersOf(s.spec);
    if (usedTables.some((t) => missing.has(t))) continue;
    if (usedTables.some((t) => pending.has(t))) {
      const known = [...catalog.values(), ...pendingCatalog];
      if (usedTables.every((t) => known.some((k) => k.slug === t)))
        for (const p of checkSpecAgainst(s.spec, known).slice(0, 6))
          problems.push(`Pantalla «${s.title}»: ${p}`);
      continue;
    }
    try {
      await validateSpec(db, s.spec, { viewerId: options.viewerId });
    } catch (err) {
      if (err instanceof ValidationError) problems.push(`Pantalla «${s.title}»: ${err.message}`);
      else throw err;
    }
    // La gente de afuera lee con la barrera del enlace público: nada interno.
    const internal = internalSourcesOf(s.spec);
    if (internal.length)
      problems.push(
        `La pantalla «${s.title}» usa información interna (${internal.map((i) => `«${i.name}»`).join(', ')}): quien no es del equipo no puede verla en una app.`,
      );
  }

  // Los flujos por estado de las tablas nuevas nombran roles de ESTA app.
  for (const t of parsed.data.tables)
    for (const f of t.fields) {
      if (!f.flow) continue;
      const named = new Set([
        ...(f.flow.transitions ?? []).flatMap((x) => x.roles ?? []),
        ...Object.values(f.flow.notify ?? {}).flatMap((n) => n.roles),
      ]);
      for (const r of named)
        if (!roleKeys.has(r) && r !== 'administrador')
          warnings.push(
            `El flujo de «${t.slug}» nombra el rol «${r}», que esta app no define: ese salto no lo podrá hacer nadie salvo quien administra.`,
          );
    }

  // Los permisos contra las tablas y los campos que de verdad existen.
  for (const r of parsed.data.roles) {
    for (const [table, perm] of Object.entries(r.permissions.tables)) {
      if (!allTables.includes(table))
        warnings.push(
          `El rol «${r.name}» tiene permisos sobre «${table}», que ninguna pantalla usa.`,
        );
      const known = tableFields.get(table);
      if (typeof perm.read === 'object') {
        if (known && !known.has(perm.read.field))
          problems.push(
            `El rol «${r.name}» filtra «${table}» por «${perm.read.field}», que no es un campo de esa tabla.`,
          );
        if (!USER_ATTRIBUTE_RE.test(perm.read.equals))
          problems.push(`El filtro del rol «${r.name}» debe ser $user.<atributo>.`);
      }
      for (const f of perm.fields ?? [])
        if (known && !known.has(f))
          problems.push(
            `El rol «${r.name}» puede escribir «${f}», que no es un campo de «${table}».`,
          );
    }
  }

  // Lo que un rol vería raro: pantalla que lee una tabla sin permiso, formulario que no puede enviar.
  for (const s of screens) {
    const seeing = s.roles.length
      ? parsed.data.roles.filter((r) => s.roles.includes(r.key))
      : parsed.data.roles;
    for (const role of seeing)
      for (const table of trackersOf(s.spec)) {
        if (table.includes('.')) continue;
        const perm = role.permissions.tables[table];
        if (!perm) {
          warnings.push(
            `El rol «${role.name}» ve «${s.title}» pero no tiene permiso sobre «${table}»: los bloques de esa tabla le saldrán con un aviso.`,
          );
          continue;
        }
        const forms = s.spec.blocks.filter((b) => b.type === 'form' && b.tracker === table);
        if (forms.length && !perm.create)
          warnings.push(
            `El rol «${role.name}» ve el formulario de «${s.title}» pero no puede registrar en «${table}».`,
          );
      }
  }
  warnings.push(...designWarnings(screens, parsed.data.roles));
  warnings.push(...locationWarnings(screens, parsed.data.roles));
  for (const r of parsed.data.roles) {
    const attrs = requiredAttributes(r.permissions);
    if (attrs.length)
      warnings.push(
        `Al invitar a alguien al rol «${r.name}» hay que decir su ${attrs.map((a) => `«${a}»`).join(' y ')}: sin ese dato no vería nada.`,
      );
    const sees = screens.some((s) => !s.roles.length || s.roles.includes(r.key));
    if (!sees) warnings.push(`El rol «${r.name}» no ve ninguna pantalla.`);
  }

  const draft: AppDraft = {
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data.icon ? { icon: parsed.data.icon } : {}),
    roles: parsed.data.roles,
    screens: screens.map((s) => ({
      title: s.title,
      slug: s.slug,
      icon: s.icon,
      roles: s.roles,
      spec: s.spec,
    })),
    ...(homeScreen ? { homeScreen } : {}),
    tables: parsed.data.tables,
  };
  const automations = [...(options.automations ?? []), ...deduceAutomations(draft)].filter(
    (a, i, all) => all.findIndex((b) => b.name === a.name) === i,
  );
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    warnings: [...new Set(warnings)],
    draft: ok ? draft : null,
    automations,
    markdown: ok ? summarize(draft, [...new Set(warnings)], automations) : '',
  };
}

/**
 * EL DISEÑO DE CADA PANTALLA SEGÚN QUIÉN LA USA. Avisos (nunca errores: la
 * persona manda) cuando una pantalla no encaja con su rol o deja a medias el
 * camino «lista → detalle»:
 *   - una lista (tarjetas, tabla, tablero, galería, calendario) sin un detalle
 *     de su tabla: tocar una fila sólo abre la ficha lateral, sin relacionados
 *     ni historia;
 *   - un formulario que alguien de planta (un rol que ve sólo lo suyo y registra)
 *     llena sin el diseño `operator`: no está pensado para el celular;
 *   - un tablero TV con formularios, botones o enlaces: en una pared no se toca.
 */
/**
 * El mapa y las tareas necesitan tres cosas a la vez: la función encendida en la
 * app, un rol que comparta y un rol que vea (y uno que asigne). Si falta una, el
 * mapa sale vacío y nadie sabe por qué: se avisa al diseñar, sin bloquear.
 */
export function locationWarnings(
  screens: Array<{ title: string; spec: ViewSpec }>,
  roles: Array<{ name: string; permissions: AppPermissions }>,
): string[] {
  const out: string[] = [];
  const someRole = (key: 'share' | 'view' | 'assign') =>
    roles.some((r) => r.permissions.location?.[key] === true);
  let people = false;
  for (const s of screens)
    for (const b of s.spec.blocks) {
      if (b.type !== 'map') continue;
      if (b.people) {
        people = true;
        if (!someRole('view'))
          out.push(
            `«${s.title}» muestra las personas en turno pero ningún rol puede verlas: marca «ve dónde están» (location.view) en el rol de quien coordina.`,
          );
        if (!someRole('share'))
          out.push(
            `«${s.title}» muestra las personas en turno pero ningún rol comparte su ubicación: marca «comparte su ubicación» (location.share) en el rol de la gente en terreno.`,
          );
      }
      if (b.assign && !someRole('assign'))
        out.push(
          `«${s.title}» asigna tareas desde el mapa pero ningún rol puede asignar: marca «asigna tareas» (location.assign) en el rol de quien coordina.`,
        );
    }
  if (people)
    out.push(
      'Para ver personas en el mapa hay que encender «Compartir ubicación del equipo» en la app (apps.update, location.enabled) y cada persona acepta compartir al iniciar su turno.',
    );
  return out;
}

export function designWarnings(
  screens: Array<{ title: string; roles: string[]; spec: ViewSpec }>,
  roles: Array<{ key: string; name: string; permissions: AppPermissionsLike }>,
): string[] {
  const out: string[] = [];
  const LISTS = new Set(['cards', 'table', 'board', 'gallery', 'calendar', 'zones']);
  const fieldRole = (r: { permissions: AppPermissionsLike }) => {
    const perms = Object.values(r.permissions.tables);
    return (
      perms.length > 0 &&
      perms.some((p) => p.create) &&
      perms.every((p) => p.read === 'own' || typeof p.read === 'object' || p.edit !== 'all')
    );
  };
  for (const s of screens) {
    const detailed = new Set(
      s.spec.blocks.flatMap((b) => (b.type === 'detail' ? [b.tracker] : [])),
    );
    const listed = [
      ...new Set(
        s.spec.blocks.flatMap((b) =>
          LISTS.has(b.type) &&
          'tracker' in b &&
          !b.tracker.includes('.') &&
          !('openRecord' in b && b.openRecord === false)
            ? [b.tracker]
            : [],
        ),
      ),
    ].filter((t) => !detailed.has(t));
    for (const t of listed)
      out.push(
        `La pantalla «${s.title}» lista «${t}» pero no tiene un detalle: tocar una fila sólo abre la ficha lateral. Agrega un bloque detail de «${t}» (datos por secciones, relacionados y línea de tiempo).`,
      );
    if (s.spec.theme?.layout === 'tv') {
      if (s.spec.blocks.some((b) => b.type === 'form' || b.type === 'voice' || b.type === 'links'))
        out.push(
          `La pantalla «${s.title}» es un tablero TV: sus formularios, botones y enlaces no se muestran en una pared.`,
        );
      continue;
    }
    const seeing = s.roles.length ? roles.filter((r) => s.roles.includes(r.key)) : roles;
    const form = s.spec.blocks.some((b) => b.type === 'form');
    if (form && s.spec.theme?.layout !== 'operator') {
      const field = seeing.filter(fieldRole);
      if (field.length)
        out.push(
          `La pantalla «${s.title}» la llena ${field.map((r) => `«${r.name}»`).join(' y ')} y no usa el diseño operario (theme.layout "operator"): en el celular de planta es más lenta de usar.`,
        );
    }
  }
  return out;
}

type AppPermissionsLike = {
  tables: Record<string, { read: unknown; create: boolean; edit: string }>;
};

/** El resumen que se le muestra a la persona para aprobar: en español simple, sin JSON. */
function summarize(
  draft: AppDraft,
  warnings: string[],
  automations: AutomationIdea[],
  designFixes: string[] = [],
): string {
  const lines: string[] = [
    `**${draft.icon ?? '📱'} ${draft.name}** — borrador (nada se ha guardado).`,
  ];
  if (draft.description) lines.push(draft.description);
  if (draft.tables.length) {
    lines.push('', '**Tablas que se crean**');
    for (const t of draft.tables) {
      const flow = t.fields.find((f) => f.flow)?.flow;
      lines.push(
        `- **${t.name}** (\`${t.slug}\`): ${t.fields.map((f) => f.label).join(', ')}${flow ? `. Flujo: ${flow.states.join(' → ')}` : ''}`,
      );
    }
  }
  lines.push('', '**Quién entra y qué ve**');
  for (const r of draft.roles) {
    const tables = Object.entries(r.permissions.tables).map(([t, p]) => {
      const bits = [
        describeRead(p.read),
        p.create ? 'registra' : null,
        p.edit !== 'none' ? describeEdit(p.edit).toLowerCase() : null,
      ];
      return `«${t}»: ${bits.filter(Boolean).join(', ').toLowerCase()}`;
    });
    lines.push(
      `- **${r.name}**${r.description ? ` — ${r.description}` : ''}. ${tables.join('; ') || 'Sin tablas.'}${r.permissions.export ? ' Exporta.' : ''}`,
    );
  }
  lines.push('', '**Pantallas**');
  for (const s of draft.screens)
    lines.push(
      `- **${s.title}** (${blockLabel(s.spec)}) — la ve ${s.roles.length ? s.roles.map((k) => draft.roles.find((r) => r.key === k)?.name ?? k).join(', ') : 'todo el mundo'}.`,
    );
  if (designFixes.length)
    lines.push('', '**Cuidé el diseño** (lo ajusté sola)', ...designFixes.map((w) => `- ${w}`));
  if (warnings.length) lines.push('', '**Para tener en cuenta**', ...warnings.map((w) => `- ${w}`));
  if (automations.length)
    lines.push(
      '',
      '**Automatizaciones sugeridas** (no se activan solas; se crean aparte en la pestaña Automatizaciones)',
      ...automations.map((a) => `- ${a.name}: cuando ${a.when}, ${a.action}.`),
    );
  lines.push(
    '',
    'Si te parece bien, la creo como borrador con apps.create (no se publica ni se invita a nadie hasta que lo apruebes).',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// La herramienta
// ---------------------------------------------------------------------------

const ROLE_DESIGN_HINT = `Design each role's screens for how that person works. START FROM THE PATTERN CATALOG (below): pick a pattern per screen, pass it in \`patterns\` with the table it runs on, and the tool builds the screen from the table's real fields (status, date, amount, owner, photo, location found by type and name); adapt it afterwards instead of drawing from scratch. Operator/field: theme.layout "operator" — voice-capable step form first, "my list" as a cards block (chips today + mine) and a detail block to open each record. Supervisor: a board by status, cards with status chips, approvals and a detail with timeline. Management: 2-4 metrics in one row at the top (with compare and goals), two charts, a ranking, no forms, export on. Client portal: theme.header "hero", their rows as cards and a detail with short sections (automations never show to external users). Plant wall: layout "tv" with 2-4 pages. Hierarchy: at most 1-2 strong blocks per screen (design.emphasis "strong"), the rest normal/quiet; a screen is never one giant block nor more than 8 blocks (use pages). Per block you may add \`design\` {surface, size, tone, emphasis, variant} as the pattern suggests (ignored if the engine does not know it yet). Money always format "money" (full pesos). Titles in plain Spanish (never snake_case or table ids). A cards/table/board/calendar block comes with a detail block of the same table.`;

const DESIGN_REVIEW_HINT = `SELF-REVIEW: every call also runs a design reviewer. It fixes the safe things by itself (returned in designFixes: money format, human titles, a detail for each list, step forms over 8 fields, cards instead of long tables for field roles, operator layout, metrics on top in a row, pages for heavy screens) and returns what it could NOT fix in designNotes. If designNotes is not empty (showable false) you MUST fix each note in the draft and call apps.design again; NEVER show the person a draft that still has unresolved designNotes. Only when showable is true show the markdown. Brand: after the person sees the screens, offer apps.suggest_brand (from the logo or the company web page) and apply it with apps.update brand only after they approve.`;

const PERMISSIONS_HINT = `Role permissions: {tables: {"<table slug>": {read: "all" | "own" | {field, equals: "$user.<attribute>"}, create: boolean, edit: "none"|"own"|"all", fields?: [field keys the role may write], actions?: ["__approve","__reject" or row action ids]}}, export: boolean, kiosk?: boolean}. A table NOT listed is invisible to that role. For a CLIENT PORTAL give the client role read {field: "<column holding the client name>", equals: "$user.cliente"}: it sees only its own rows (also in totals and exports).`;

export const appsDesign = registerTool({
  id: 'apps.design',
  description: `Draft a COMPLETE application from a description WITHOUT saving anything, so the person can approve it before it exists: roles with plain-language permissions, screens with valid specs (checked against the real tables), and suggested automations as text. You compose the draft (name, roles, screens, homeScreen — the same shape apps.create takes, or start from template "${APP_TEMPLATES.map((t) => t.id).join('" / "')}" and the tool returns it ready) and this tool validates every screen against the workspace's real tables, cross-checks roles with screens and returns {ok, problems, warnings, draft, automations, markdown}. If ok is false, fix exactly the problems and call it again. If ok, show the markdown summary to the person; when they approve, call apps.create passing the draft's fields unchanged (name, description, icon, roles, screens, homeScreen). ALWAYS call this before apps.create for anything that is not the plain template. If the data lives in a Google Sheet or Drive folder, FIRST call trackers.propose_from_source / trackers.propose_from_drive_folder and wait for approval; a screen on a table that does not exist comes back as a problem. Read-only (no confirmation); company owners/admins only.
${PERMISSIONS_HINT}
${ROLE_DESIGN_HINT}
${DESIGN_REVIEW_HINT}
SCREEN PATTERN CATALOG (ids for \`patterns\`):
${describePatterns()}
${SPEC_GRAMMAR}`,
  inputSchema: z
    .object({
      description: z
        .string()
        .trim()
        .min(4)
        .max(2000)
        .describe('What the person asked for, in their words (kept in the summary).'),
      template: z
        .enum(APP_TEMPLATES.map((t) => t.id) as [string, ...string[]])
        .optional()
        .describe('Start from a ready-made template instead of passing roles/screens.'),
      name: z.string().trim().min(1).max(80).optional(),
      appDescription: z.string().trim().max(500).optional(),
      icon: z.string().trim().max(400).optional().describe('An emoji.'),
      roles: z.array(z.unknown()).max(MAX_APP_ROLES).optional(),
      screens: z.array(z.unknown()).max(MAX_APP_SCREENS).optional(),
      homeScreen: z.string().trim().max(48).optional(),
      tables: z
        .array(z.unknown())
        .max(8)
        .optional()
        .describe(
          'New tables the app needs, created WITH the app on approval: [{slug, name, description, fields}] (same fields grammar as trackers.define; a select field may carry a `flow` of states). A table that already exists is used as is.',
        ),
      patterns: z
        .array(
          z.object({
            pattern: z.enum(PATTERN_IDS).describe('Pattern id from the SCREEN PATTERN CATALOG.'),
            table: z
              .string()
              .trim()
              .min(1)
              .max(48)
              .describe('Slug of the table it runs on (existing, or one of `tables` of this call).'),
            title: z.string().trim().min(1).max(60).optional().describe('Screen title in plain Spanish.'),
            roles: z.array(roleKeySchema).max(MAX_APP_ROLES).optional().describe('Role keys that see it.'),
          }),
        )
        .max(MAX_APP_SCREENS)
        .optional()
        .describe(
          'Screens to build FROM THE PATTERN CATALOG on real tables; they are added to `screens`. If a pattern needs a field the table lacks, the tool says which.',
        ),
      automations: z
        .array(automationIdea)
        .max(8)
        .optional()
        .describe(
          'Suggested automations as text: name, when (trigger), action. They are NOT activated.',
        ),
    })
    .superRefine((v, ctx) => {
      if (!v.template && (!v.name || !(v.screens?.length || v.patterns?.length) || !v.roles?.length))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Sin plantilla hacen falta name, roles y screens.',
        });
    }),
  outputSchema: z.object({
    ok: z.boolean(),
    problems: z.array(z.string()),
    warnings: z.array(z.string()),
    draft: z.unknown().nullable(),
    automations: z.array(automationIdea),
    markdown: z.string(),
    /** Lo que el revisor de diseño no pudo arreglar solo: hay que corregirlo antes de mostrar. */
    designNotes: z.array(z.string()).default([]),
    /** Lo que el revisor corrigió solo. */
    designFixes: z.array(z.string()).default([]),
    /** ok y sin notas de diseño: ya se puede mostrar el borrador. */
    showable: z.boolean().default(false),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError(
        'Sólo quien administra la empresa o es su dueño puede diseñar una aplicación.',
      );
    const template = input.template ? APP_TEMPLATES.find((t) => t.id === input.template) : null;

    // Pantallas del catálogo: se arman sobre las tablas reales (o las que este borrador crea).
    const patternScreens: unknown[] = [];
    const patternProblems: string[] = [];
    if (input.patterns?.length) {
      const known = new Map<string, PatternTable>();
      for (const raw of input.tables ?? []) {
        const t = tableDraftSchema.safeParse(raw);
        if (t.success) known.set(t.data.slug, t.data);
      }
      for (const slug of new Set(input.patterns.map((p) => p.table)))
        if (!known.has(slug)) {
          const tracker = await getTrackerBySlug(ctx.db, slug);
          if (tracker) known.set(slug, { slug, name: tracker.name, fields: tracker.fields });
        }
      for (const p of input.patterns) {
        const table = known.get(p.table);
        if (!table) {
          patternProblems.push(
            `El patrón «${p.pattern}» corre sobre la tabla «${p.table}», que no existe. Propón la tabla primero (trackers.define / propose_from_source) o ponla en \`tables\`.`,
          );
          continue;
        }
        const built = buildScreenFromPattern(p.pattern, table, {
          title: p.title,
          roles: p.roles,
          relatedTables: [...known.values()],
        });
        if (!built.ok) patternProblems.push(built.reason);
        else patternScreens.push(built.screen);
      }
    }
    if (patternProblems.length)
      return {
        ok: false,
        problems: patternProblems,
        warnings: [],
        draft: null,
        automations: input.automations ?? [],
        markdown: '',
        designNotes: [],
        designFixes: [],
        showable: false,
      };
    const screensIn = [...(input.screens ?? []), ...patternScreens];

    const raw = template
      ? {
          name: input.name ?? template.name,
          description: input.appDescription ?? template.body,
          icon: input.icon ?? template.icon,
          roles: template.roles,
          screens: [
            ...template.screens.map((s) => ({
              title: s.title,
              slug: s.slug,
              icon: s.icon,
              roles: s.roles,
              spec: s.spec,
            })),
            ...patternScreens,
          ],
          homeScreen: template.homeScreen,
          tables: input.tables ?? [],
        }
      : {
          name: input.name,
          description: input.appDescription ?? '',
          icon: input.icon,
          roles: input.roles,
          screens: screensIn,
          homeScreen: input.homeScreen,
          tables: input.tables ?? [],
        };
    // La plantilla trae sus propias tablas: si la empresa aún no las tiene, las crea apps.create.
    const review = await reviewAppDraft(ctx.db, raw, {
      viewerId: ctx.userId,
      automations: input.automations,
      willCreate: new Map(
        (template?.trackers ?? []).map((t) => [t.slug, t.fields.map((f) => f.key)] as const),
      ),
    });
    if (!review.ok || !review.draft)
      return { ...review, designNotes: [], designFixes: [], showable: false };

    // Autorrevisión del diseño: corrige lo seguro y deja las notas de lo que no.
    let designNotes: DesignNote[] = [];
    let designFixes: string[] = [];
    let draft = review.draft;
    let warnings = review.warnings;
    try {
      const catalog = await tablesForReview(ctx.db, draft, template?.trackers ?? []);
      const reviewed = reviewAppDesign(draft, catalog);
      const before = designWarnings(draft.screens, draft.roles);
      draft = reviewed.draft;
      designNotes = reviewed.notes;
      designFixes = reviewed.fixes;
      // Los avisos de diseño de antes se reemplazan por los del borrador ya corregido.
      warnings = [
        ...new Set([
          ...review.warnings.filter((w) => !before.includes(w)),
          ...designWarnings(draft.screens, draft.roles),
        ]),
      ];
    } catch (err) {
      console.warn('[apps.design] revisión de diseño omitida:', err instanceof Error ? err.message : err);
    }
    const showable = designNotes.length === 0;
    const noteLines = designNoteLines(designNotes);
    return {
      ...review,
      draft,
      warnings,
      designNotes: noteLines,
      designFixes,
      showable,
      markdown: showable
        ? summarize(draft, warnings, review.automations, designFixes)
        : `NO se lo muestres a la persona todavía: el diseño tiene ${noteLines.length} nota(s) sin resolver. Corrígelas en el borrador y vuelve a llamar apps.design.\n${noteLines.map((n) => `- ${n}`).join('\n')}`,
    };
  },
});

/** Las tablas que usa el borrador, con sus campos: las que existen y las que la app crea. */
async function tablesForReview(
  db: SupabaseClient,
  draft: AppDraft,
  templateTables: Array<{ slug: string; name: string; fields: PatternTable['fields'] }>,
): Promise<PatternTable[]> {
  const out = new Map<string, PatternTable>();
  for (const t of templateTables) out.set(t.slug, { slug: t.slug, name: t.name, fields: t.fields });
  for (const t of draft.tables) out.set(t.slug, { slug: t.slug, name: t.name, fields: t.fields });
  const slugs = new Set(draft.screens.flatMap((s) => trackersOf(s.spec)));
  for (const slug of slugs) {
    if (slug.includes('.') || out.has(slug)) continue;
    const tracker = await getTrackerBySlug(db, slug);
    if (tracker) out.set(slug, { slug, name: tracker.name, fields: tracker.fields });
  }
  return [...out.values()];
}
