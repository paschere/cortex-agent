import type { TrackerField } from '../trackers/schema';
import { type CatalogTracker, type ViewSpec, slugify, viewSpecSchema } from '../views/spec';

/**
 * CATÁLOGO DE PATRONES DE PANTALLA.
 *
 * No son apps enteras: son pantallas probadas («Mi lista de hoy», «Panel
 * gerencial»…) descritas como DATOS (para quién, qué bloques y en qué orden,
 * qué campo va en cada sitio por su ROL SEMÁNTICO: estado, fecha, monto,
 * responsable, foto, ubicación) más una función pura, `buildScreenFromPattern`,
 * que dado un patrón y una tabla real (sus campos y tipos) produce la pantalla
 * como un ViewSpec válido. El motor sigue siendo general: nada aquí nombra una
 * tabla ni un cliente; los campos se descubren por tipo y por el nombre que
 * tengan (español o inglés), y lo que no se encuentra no se inventa: el bloque
 * que lo necesitaba simplemente no sale.
 *
 * `design` por bloque: cada bloque lleva una SUGERENCIA de diseño (superficie,
 * tamaño, énfasis, tono, variante). El campo `design` de los bloques lo añade
 * otra pieza del sistema; aquí se emite con tolerancia: si el esquema vigente
 * aún no lo conoce (o no acepta algún valor), la pantalla se arma sin él y el
 * resto no cambia.
 */

// ---------------------------------------------------------------------------
// Roles semánticos de los campos
// ---------------------------------------------------------------------------

export const FIELD_ROLE_NAMES = [
  'title',
  'subtitle',
  'status',
  'date',
  'time',
  'amount',
  'quantity',
  'owner',
  'client',
  'photo',
  'location',
  'notes',
] as const;
export type FieldRoleName = (typeof FIELD_ROLE_NAMES)[number];

export type PatternTable = Pick<CatalogTracker, 'slug' | 'name' | 'fields'>;

export interface FieldRoles {
  /** Siempre hay uno: un campo de texto o `label`. */
  title: string;
  subtitle?: string;
  status?: string;
  date?: string;
  time?: string;
  amount?: string;
  quantity?: string;
  owner?: string;
  client?: string;
  photo?: string;
  /** Sólo un campo de tipo ubicación (lo que el mapa exige). */
  location?: string;
  /** Un texto corto de lugar («Muelle 3») cuando no hay campo de ubicación. */
  place?: string;
  notes?: string;
}

const RE = {
  status: /estado|status|etapa|fase|situaci/i,
  date: /fecha|vence|vencimiento|programad|entrega|cita|inicio|plazo|date/i,
  amount: /monto|valor|total|precio|costo|importe|pago|amount|price|cost/i,
  owner:
    /responsable|asignad|operari|encargad|vendedor|t[eé]cnic|conductor|registrad|propietari|owner|assigned/i,
  client: /cliente|empresa|proveedor|contacto|customer|client/i,
  title:
    /nombre|t[ií]tulo|n[uú]mero|c[oó]digo|gu[ií]a|referencia|placa|descripci|asunto|producto|name|title|code/i,
  place: /ubicaci|direcci|lugar|sede|muelle|zona|bodega|location|address/i,
  photo: /foto|imagen|evidencia|picture|photo|image/i,
};

/** Descubre qué campo hace de qué en una tabla. Puro y determinista. */
export function inferFieldRoles(table: PatternTable): FieldRoles {
  const fields = table.fields;
  const byType = (...types: string[]) => fields.filter((f) => types.includes(f.type));
  const pick = (list: TrackerField[], re: RegExp) =>
    list.find((f) => re.test(f.key) || re.test(f.label));

  const selects = byType('select');
  const status =
    selects.find((f) => f.flow) ??
    pick(selects, RE.status) ??
    (selects.length === 1 ? selects[0] : undefined);

  const dates = byType('date');
  const date = pick(dates, RE.date) ?? dates[0];
  const time = byType('time')[0];

  const moneys = byType('money');
  const amount = pick(moneys, RE.amount) ?? moneys[0];
  const quantity = byType('number')[0];

  const used = new Set<string>([status?.key, date?.key, amount?.key].filter(Boolean) as string[]);
  const textish = byType('text', 'longtext', 'select', 'relation').filter((f) => !used.has(f.key));
  const owner = pick(textish, RE.owner);
  const client = pick(
    textish.filter((f) => f.key !== owner?.key),
    RE.client,
  );

  const files = byType('file').filter((f) => f.accept !== 'signature');
  const photo = pick(files, RE.photo) ?? files.find((f) => f.accept === 'image') ?? files[0];
  const location = byType('location')[0];

  const texts = byType('text');
  const title =
    texts.find((f) => f.required && RE.title.test(`${f.key} ${f.label}`)) ??
    texts.find((f) => RE.title.test(`${f.key} ${f.label}`)) ??
    texts.find((f) => f.required) ??
    texts[0];
  const rest = texts.filter((f) => f.key !== title?.key && f.key !== owner?.key);
  const place = pick(rest, RE.place);
  const subtitle =
    client && client.key !== title?.key
      ? client
      : (rest.find((f) => f.key !== place?.key) ?? place);
  const notes = byType('longtext')[0];

  const roles: FieldRoles = { title: title?.key ?? 'label' };
  const set = (k: Exclude<keyof FieldRoles, 'title'>, f: TrackerField | undefined) => {
    if (f) roles[k] = f.key;
  };
  set('subtitle', subtitle && subtitle.key !== title?.key ? subtitle : undefined);
  set('status', status);
  set('date', date);
  set('time', time);
  set('amount', amount);
  set('quantity', quantity);
  set('owner', owner);
  set('client', client);
  set('photo', photo);
  set('location', location);
  set('place', place);
  set('notes', notes);
  return roles;
}

// ---------------------------------------------------------------------------
// El catálogo (datos)
// ---------------------------------------------------------------------------

export const PATTERN_IDS = [
  'mi_lista_hoy',
  'registrar',
  'tablero_estado',
  'detalle_linea_tiempo',
  'mapa_con_lista',
  'agenda',
  'panel_gerencial',
  'portal_cliente',
  'pantalla_planta_tv',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export interface PatternBlockPlan {
  /** Tipo de bloque. */
  type: string;
  /** Qué campos (por rol semántico) van en él. */
  uses: string;
  /** Sugerencia de diseño con el vocabulario de `design` (surface, emphasis, variant, height…). */
  design: Record<string, string>;
}

export interface ScreenPattern {
  id: PatternId;
  name: string;
  /** Para qué rol, en palabras de la persona. */
  forRole: string;
  /** Qué problema resuelve, en una frase. */
  summary: string;
  /** Roles semánticos sin los cuales el patrón no tiene sentido. */
  needs: FieldRoleName[];
  /** Bloques en orden. */
  blocks: PatternBlockPlan[];
  /** Cómo se ve (theme). */
  look: string;
  /** Ícono de menú (del set de apps). */
  icon: string;
}

export const SCREEN_PATTERNS: readonly ScreenPattern[] = [
  {
    id: 'mi_lista_hoy',
    name: 'Mi lista de hoy',
    forRole: 'operario / gente en terreno',
    summary: 'Lo que me toca hoy como tarjetas grandes con su estado; tocar una abre el detalle.',
    needs: [],
    look: 'layout operator, density comfortable, una columna, controles grandes',
    icon: 'ListChecks',
    blocks: [
      {
        type: 'metric ×2 (half)',
        uses: 'status (pendientes), date (de hoy)',
        design: { surface: 'tinted', emphasis: 'quiet', variant: 'number' },
      },
      {
        type: 'cards',
        uses: 'title, subtitle, photo, status (chips), date (hoy/semana), 2-3 datos (place, amount)',
        design: { surface: 'card', emphasis: 'strong', variant: 'image' },
      },
      {
        type: 'detail',
        uses: 'secciones por rol (qué, cuándo y dónde, valores), línea de tiempo',
        design: { surface: 'card', variant: 'sections' },
      },
    ],
  },
  {
    id: 'registrar',
    name: 'Registrar',
    forRole: 'operario / gente en terreno',
    summary: 'Formulario por pasos, con dictado o «llenar hablando», y lo último que registré.',
    needs: [],
    look: 'layout operator, density comfortable; el formulario primero',
    icon: 'ClipboardPlus',
    blocks: [
      {
        type: 'form (por pasos, voz)',
        uses: 'pasos: qué (title, subtitle) · cuándo y dónde (date, time, location/place) · detalles (amount, quantity, opciones) · evidencia (photo, notes). El estado NO se pide: lo pone el flujo.',
        design: { surface: 'card', emphasis: 'strong' },
      },
      {
        type: 'cards (lo último que registré)',
        uses: 'title, status, date; chip mine',
        design: { surface: 'plain', emphasis: 'quiet', variant: 'compact' },
      },
    ],
  },
  {
    id: 'tablero_estado',
    name: 'Tablero por estado',
    forRole: 'supervisor / coordinación',
    summary: 'Columnas por estado que se arrastran, con Aprobar/Rechazar y el detalle al tocar.',
    needs: ['status'],
    look: 'layout dashboard, density comfortable',
    icon: 'LayoutGrid',
    blocks: [
      {
        type: 'metric ×3 (third)',
        uses: 'total, por revisar (primer estado), esta semana (date)',
        design: { surface: 'tinted', emphasis: 'quiet', variant: 'number' },
      },
      {
        type: 'board',
        uses: 'columnas = status; ficha: date, owner, amount, place; botones Aprobar/Rechazar si hay opciones de aprobación',
        design: { surface: 'card', emphasis: 'strong', variant: 'columns' },
      },
      {
        type: 'detail',
        uses: 'secciones, línea de tiempo con aprobaciones',
        design: { surface: 'card', variant: 'sections' },
      },
    ],
  },
  {
    id: 'detalle_linea_tiempo',
    name: 'Detalle con línea de tiempo',
    forRole: 'supervisor, soporte, quien investiga un caso',
    summary:
      'Buscar un registro y ver todo de él: datos por secciones, fotos, relacionados e historia.',
    needs: [],
    look: 'layout dashboard',
    icon: 'FileText',
    blocks: [
      {
        type: 'table (buscador)',
        uses: 'title, status, date, owner/client, amount',
        design: { surface: 'card', variant: 'lined' },
      },
      {
        type: 'detail',
        uses: 'cabecera title/subtitle/status; secciones; galería de photo; relacionados de tablas ligadas; línea de tiempo completa',
        design: { surface: 'card', emphasis: 'strong', variant: 'timeline-first' },
      },
    ],
  },
  {
    id: 'mapa_con_lista',
    name: 'Mapa con lista',
    forRole: 'coordinación, ruteo, visitas',
    summary: 'Los registros en el mapa, coloreados por estado, y la lista para abrirlos.',
    needs: ['location'],
    look: 'layout dashboard',
    icon: 'MapPin',
    blocks: [
      {
        type: 'map',
        uses: 'location, color por status, title y subtitle en el marcador',
        design: { surface: 'card', emphasis: 'strong', height: 'tall' },
      },
      {
        type: 'cards',
        uses: 'title, subtitle, status, date',
        design: { surface: 'plain', variant: 'compact' },
      },
      {
        type: 'detail',
        uses: 'secciones y línea de tiempo',
        design: { surface: 'card', variant: 'sections' },
      },
    ],
  },
  {
    id: 'agenda',
    name: 'Agenda / calendario',
    forRole: 'quien programa: citas, entregas, turnos',
    summary: 'Día, semana o mes con los eventos coloreados por estado y lo de hoy aparte.',
    needs: ['date'],
    look: 'layout dashboard',
    icon: 'Calendar',
    blocks: [
      {
        type: 'calendar (día/semana/mes)',
        uses: 'date, time (hora), title, color por status',
        design: { surface: 'card', emphasis: 'strong', variant: 'agenda' },
      },
      {
        type: 'cards (hoy)',
        uses: 'title, status, date, place; chip hoy',
        design: { surface: 'plain', variant: 'compact' },
      },
      {
        type: 'detail',
        uses: 'secciones',
        design: { surface: 'card', variant: 'sections' },
      },
    ],
  },
  {
    id: 'panel_gerencial',
    name: 'Panel gerencial',
    forRole: 'gerencia / dueño',
    summary:
      'Cifras clave contra el período anterior, dos gráficos y un ranking. Sin formularios.',
    needs: [],
    look: 'layout dashboard, header plain, style clean',
    icon: 'LayoutDashboard',
    blocks: [
      {
        type: 'metric ×3 (third)',
        uses: 'registros y total (amount) contra el período anterior (date), por revisar (status)',
        design: { surface: 'card', emphasis: 'strong', variant: 'compare' },
      },
      {
        type: 'chart ×2 (half)',
        uses: 'evolución por mes (date, amount) y reparto por status u owner',
        design: { surface: 'card', variant: 'area' },
      },
      {
        type: 'progress (ranking)',
        uses: 'por owner/client, suma de amount o conteo, top 8',
        design: { surface: 'card', variant: 'bar' },
      },
    ],
  },
  {
    id: 'portal_cliente',
    name: 'Portal de cliente',
    forRole: 'cliente externo',
    summary: 'Bienvenida con cabecera grande y sus registros como tarjetas; nada interno.',
    needs: [],
    look: 'header hero, layout dashboard; el rol del cliente filtra por su atributo',
    icon: 'User',
    blocks: [
      {
        type: 'metric ×2 (half)',
        uses: 'sus registros en trámite (status), total (amount)',
        design: { surface: 'tinted', emphasis: 'quiet', variant: 'number' },
      },
      {
        type: 'cards',
        uses: 'title, subtitle, photo, status, date, amount',
        design: { surface: 'card', emphasis: 'strong', variant: 'rich' },
      },
      {
        type: 'detail',
        uses: 'secciones cortas y línea de tiempo (sin automatizaciones)',
        design: { surface: 'card', variant: 'sections' },
      },
    ],
  },
  {
    id: 'pantalla_planta_tv',
    name: 'Pantalla de planta (TV)',
    forRole: 'pared de planta / sala de control',
    summary: 'Cifras grandes y estado de la operación que rotan solas, de lejos y sin tocar nada.',
    needs: [],
    look: 'layout tv, style dark-panel, rota cada 15 s, 2 páginas',
    icon: 'Table2',
    blocks: [
      {
        type: 'metric ×3 (third)',
        uses: 'total de hoy (date), por hacer (status), monto (amount)',
        design: { surface: 'card', emphasis: 'strong', variant: 'number' },
      },
      {
        type: 'chart (donut)',
        uses: 'reparto por status',
        design: { surface: 'card', variant: 'donut' },
      },
      {
        type: 'board corto',
        uses: 'status; date',
        design: { surface: 'card', variant: 'compact' },
      },
    ],
  },
];

export function getScreenPattern(id: string): ScreenPattern | undefined {
  return SCREEN_PATTERNS.find((p) => p.id === id);
}

/** El catálogo como texto para el prompt de `apps.design`. */
export function describePatterns(): string {
  return SCREEN_PATTERNS.map(
    (p) =>
      `- ${p.id} «${p.name}» (${p.forRole}): ${p.summary} Bloques: ${p.blocks
        .map((b) => `${b.type} [${b.uses}]`)
        .join(' → ')}. Aspecto: ${p.look}.${p.needs.length ? ` Necesita campos de: ${p.needs.join(', ')}.` : ''}`,
  ).join('\n');
}

// ---------------------------------------------------------------------------
// La función pura: patrón + tabla → pantalla
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Título de la pantalla; por defecto el del patrón. */
  title?: string;
  /** Claves de rol que la ven (vacío = todos). */
  roles?: string[];
  /** Otras tablas de la app: si apuntan a ésta con una relación, salen como relacionados del detalle. */
  relatedTables?: PatternTable[];
  /** Emitir la sugerencia `design` en cada bloque (por defecto sí, con tolerancia). */
  includeDesign?: boolean;
}

export interface BuiltScreen {
  title: string;
  slug: string;
  icon: string;
  roles: string[];
  spec: ViewSpec;
}

export type BuildResult =
  | { ok: true; screen: BuiltScreen; used: FieldRoles; hadDesign: boolean }
  | { ok: false; missing: FieldRoleName[]; reason: string };

type Raw = Record<string, unknown>;

const ROLE_WORD: Record<FieldRoleName, string> = {
  title: 'un texto principal',
  subtitle: 'un texto secundario',
  status: 'un campo de estado (de opciones)',
  date: 'un campo de fecha',
  time: 'un campo de hora',
  amount: 'un campo de dinero',
  quantity: 'un campo de número',
  owner: 'un responsable',
  client: 'un cliente',
  photo: 'un campo de foto',
  location: 'un campo de tipo ubicación',
  notes: 'un texto largo',
};

const compact = <T>(list: Array<T | undefined | null | false | 0 | ''>): T[] =>
  list.filter((x): x is T => Boolean(x));

function labelOf(table: PatternTable, key?: string): string {
  if (!key) return '';
  return table.fields.find((f) => f.key === key)?.label ?? key;
}

function dg(d: Record<string, string>, tone?: string): Raw {
  return { ...d, ...(tone ? { tone } : {}) };
}

/** Secciones del detalle: los campos agrupados por lo que significan. */
function detailSections(
  table: PatternTable,
  r: FieldRoles,
): Array<{ title: string; fields: string[] }> {
  const used = new Set<string>();
  const take = (keys: Array<string | undefined>) => {
    const out = compact(keys).filter(
      (k) => !used.has(k) && table.fields.some((f) => f.key === k),
    );
    for (const k of out) used.add(k);
    return out;
  };
  const media = new Set(table.fields.filter((f) => f.type === 'file').map((f) => f.key));
  const what = take([r.title, r.subtitle, r.client, r.owner]);
  const when = take([r.date, r.time, r.place, r.location]);
  const money = take([r.amount, r.quantity]);
  const others = table.fields
    .filter((f) => !used.has(f.key) && !media.has(f.key) && f.key !== r.notes)
    .map((f) => f.key)
    .slice(0, 8);
  const extra = take([...others, r.notes]);
  return [
    { title: 'Datos', fields: what },
    { title: 'Cuándo y dónde', fields: when },
    { title: 'Valores', fields: money },
    { title: 'Más información', fields: extra },
  ]
    .filter((s) => s.fields.length > 0)
    .map((s) => ({ ...s, fields: s.fields.slice(0, 12) }));
}

/** Pasos de un formulario: qué · cuándo y dónde · detalles · evidencia (máx. 6 campos por paso). */
export function formStepsFor(
  table: PatternTable,
  fieldKeys: string[],
  r: FieldRoles = inferFieldRoles(table),
): Array<{ title: string; fields: string[] }> {
  const left = new Set(fieldKeys);
  const take = (pred: (f: TrackerField) => boolean) => {
    const keys = table.fields.filter((f) => left.has(f.key) && pred(f)).map((f) => f.key);
    for (const k of keys) left.delete(k);
    return keys;
  };
  const what = take((f) => [r.title, r.subtitle, r.client, r.owner].includes(f.key));
  const when = take(
    (f) => f.type === 'date' || f.type === 'time' || f.type === 'location' || f.key === r.place,
  );
  const evidence = take((f) => f.type === 'file' || f.type === 'longtext');
  const details = take(() => true);
  const groups = [
    { title: 'Qué es', fields: what },
    { title: 'Cuándo y dónde', fields: when },
    { title: 'Detalles', fields: details },
    { title: 'Evidencia', fields: evidence },
  ].filter((g) => g.fields.length > 0);
  const out: Array<{ title: string; fields: string[] }> = [];
  for (const g of groups)
    for (let i = 0; i < g.fields.length; i += 6)
      out.push({
        title: i === 0 ? g.title : `${g.title} (${i / 6 + 1})`,
        fields: g.fields.slice(i, i + 6),
      });
  return out.slice(0, 10);
}

function detailBlock(
  table: PatternTable,
  r: FieldRoles,
  opts: { id?: string; timeline?: unknown; related?: PatternTable[]; design?: Raw } = {},
): Raw {
  const related = (opts.related ?? []).flatMap((t) => {
    if (t.slug === table.slug) return [];
    const rel = t.fields.find((f) => f.type === 'relation' && f.tracker === table.slug);
    if (!rel) return [];
    const tr = inferFieldRoles(t);
    return [
      {
        id: t.slug.slice(0, 15),
        title: t.name.slice(0, 60),
        tracker: t.slug,
        field: rel.key,
        columns: compact([tr.title, tr.status, tr.date]).slice(0, 4),
        limit: 10,
      },
    ];
  });
  const photos = table.fields
    .filter((f) => f.type === 'file' && f.accept !== 'signature')
    .map((f) => f.key);
  return {
    id: opts.id ?? 'detalle',
    type: 'detail',
    width: 'full',
    tracker: table.slug,
    titleField: r.title,
    ...(r.subtitle ? { subtitleField: r.subtitle } : {}),
    ...(r.status ? { statusField: r.status } : {}),
    sections: detailSections(table, r),
    gallery: photos.slice(0, 4),
    related: related.slice(0, 4),
    timeline: opts.timeline ?? {
      show: ['created', 'changes', 'approvals', 'automations', 'files'],
      limit: 30,
    },
    ...(opts.design ? { design: opts.design } : {}),
  };
}

/** Un bloque de detalle para una lista que no lo tiene (lo usa el revisor de diseño). */
export function buildDetailBlock(
  table: PatternTable,
  relatedTables: PatternTable[] = [],
  id = 'detalle',
): Raw {
  return detailBlock(table, inferFieldRoles(table), { id, related: relatedTables });
}

function metric(
  id: string,
  table: PatternTable,
  title: string,
  extra: Raw = {},
  width: 'half' | 'third' | 'full' = 'third',
): Raw {
  return { id, type: 'metric', width, tracker: table.slug, title, aggregate: 'count', ...extra };
}

function firstOption(table: PatternTable, key?: string): string | undefined {
  return table.fields.find((f) => f.key === key)?.options?.[0];
}

function approvalOptions(
  table: PatternTable,
  key?: string,
): { approved?: string; rejected?: string } {
  const opts = table.fields.find((f) => f.key === key)?.options ?? [];
  return {
    approved: opts.find((o) => /aprobad|aceptad|autorizad|approved/i.test(o)),
    rejected: opts.find((o) => /rechazad|negad|rejected/i.test(o)),
  };
}

function cardsBlock(
  table: PatternTable,
  r: FieldRoles,
  o: { chips?: string[]; id?: string } & Raw = {},
): Raw {
  const { chips: wanted = [], ...rest } = o;
  const chips = wanted.filter((c) =>
    c === 'status' ? r.status : c === 'today' || c === 'week' ? r.date : true,
  );
  return {
    id: 'lista',
    type: 'cards',
    width: 'full',
    tracker: table.slug,
    title: table.name,
    titleField: r.title,
    ...(r.subtitle ? { subtitleField: r.subtitle } : {}),
    ...(r.photo ? { imageField: r.photo } : {}),
    ...(r.status ? { statusField: r.status } : {}),
    dataFields: compact([r.date, r.place, r.amount, r.owner, r.quantity]).slice(0, 3),
    ...(r.date ? { dateField: r.date } : {}),
    chips,
    sort: { field: r.date ?? 'created_at', dir: 'desc' },
    ...rest,
  };
}

const THEME = {
  operator: { layout: 'operator', density: 'comfortable' },
  dashboard: { layout: 'dashboard', density: 'comfortable' },
} as const;

function specBase(extra: Raw): Raw {
  return {
    version: 1,
    accent: 'primary',
    refreshSeconds: 30,
    editing: 'off',
    alerts: [],
    ...extra,
  };
}

function stripDesign(spec: Raw): Raw {
  const blocks = (spec.blocks as Raw[]).map((b) => {
    const { design: _design, ...rest } = b;
    return rest;
  });
  return { ...spec, blocks };
}

/** Pantalla desde un patrón y una tabla. Pura: no toca la base. */
export function buildScreenFromPattern(
  patternId: string,
  table: PatternTable,
  options: BuildOptions = {},
): BuildResult {
  const pattern = getScreenPattern(patternId);
  if (!pattern)
    return {
      ok: false,
      missing: [],
      reason: `No existe el patrón «${patternId}». Los hay: ${PATTERN_IDS.join(', ')}.`,
    };
  const r = inferFieldRoles(table);
  const missing = pattern.needs.filter((n) => !r[n]);
  if (missing.length)
    return {
      ok: false,
      missing,
      reason: `«${pattern.name}» necesita ${missing.map((m) => ROLE_WORD[m]).join(' y ')} en «${table.name}», y no lo tiene. Agrégalo a la tabla (trackers.define) o elige otro patrón.`,
    };

  const d = (i: number, tone?: string): Raw => dg(pattern.blocks[i]?.design ?? {}, tone);
  const amountType = table.fields.find((f) => f.key === r.amount)?.type;
  const amountFormat = amountType === 'money' ? 'money' : 'number';
  const firstState = firstOption(table, r.status);
  const label = table.name;
  const blocks: Raw[] = [];
  let spec: Raw = {};
  const related = options.relatedTables;

  switch (pattern.id) {
    case 'mi_lista_hoy': {
      if (r.status && firstState)
        blocks.push(
          metric(
            'pendientes',
            table,
            'Por hacer',
            {
              filters: [{ field: r.status, op: 'eq', value: firstState }],
              tone: 'amber',
              design: d(0, 'amber'),
            },
            'half',
          ),
        );
      if (r.date)
        blocks.push(
          metric(
            'hoy',
            table,
            'De hoy',
            {
              filters: [{ field: r.date, op: 'last_days', value: 1 }],
              tone: 'emerald',
              design: d(0, 'emerald'),
            },
            'half',
          ),
        );
      blocks.push({
        ...cardsBlock(table, r, { chips: ['today', 'status', 'mine'], pageSize: 12 }),
        design: { ...d(1), variant: r.photo ? 'image' : 'rich' },
      });
      blocks.push(detailBlock(table, r, { related, design: d(2) }));
      spec = specBase({
        theme: { ...THEME.operator, accent: 'emerald' },
        editing: 'team',
        blocks,
      });
      break;
    }
    case 'registrar': {
      const askable = table.fields.filter((f) => f.key !== r.status).map((f) => f.key);
      const steps = askable.length >= 5 ? formStepsFor(table, askable, r) : undefined;
      blocks.push({
        id: 'registrar',
        type: 'form',
        width: 'full',
        tracker: table.slug,
        title: `Registrar ${label.toLowerCase()}`.slice(0, 120),
        intro: 'Dicta o escribe, toma la foto y envía. Sin señal se guarda y se envía después.',
        fields: askable.slice(0, 20),
        ...(steps ? { steps } : {}),
        submitLabel: 'Registrar',
        successMessage: 'Listo, quedó registrado.',
        voice: askable.length >= 4 ? 'conversation' : 'dictate',
        design: d(0),
      });
      blocks.push({
        ...cardsBlock(table, r, {
          id: 'ultimos',
          chips: ['mine', 'today'],
          pageSize: 4,
          searchable: false,
          limit: 20,
          title: 'Lo último que registré',
        }),
        design: d(1),
      });
      blocks.push(detailBlock(table, r, { related }));
      spec = specBase({
        theme: { ...THEME.operator, accent: 'emerald' },
        refreshSeconds: 0,
        editing: 'team',
        blocks,
      });
      break;
    }
    case 'tablero_estado': {
      const { approved, rejected } = approvalOptions(table, r.status);
      const actions = compact([
        approved && r.status
          ? { id: 'aprobar', label: 'Aprobar', kind: 'set_field', field: r.status, value: approved }
          : null,
        rejected && r.status
          ? {
              id: 'rechazar',
              label: 'Rechazar',
              kind: 'set_field',
              field: r.status,
              value: rejected,
              confirm: true,
            }
          : null,
      ]);
      blocks.push(metric('total', table, `${label} en total`, { design: d(0) }));
      if (firstState && r.status)
        blocks.push(
          metric('por_revisar', table, 'Por revisar', {
            filters: [{ field: r.status, op: 'eq', value: firstState }],
            tone: 'amber',
            design: d(0, 'amber'),
          }),
        );
      if (r.date)
        blocks.push(
          metric('semana', table, 'Esta semana', {
            compare: 'previous_period',
            period: 'week',
            dateField: r.date,
            design: d(0),
          }),
        );
      blocks.push({
        id: 'tablero',
        type: 'board',
        width: 'full',
        tracker: table.slug,
        title: `${label} por estado`,
        groupBy: r.status,
        cardFields: compact([r.date, r.owner, r.amount, r.place]).slice(0, 4),
        draggable: true,
        actions,
        design: d(1),
      });
      blocks.push(detailBlock(table, r, { related, design: d(2) }));
      spec = specBase({
        theme: { ...THEME.dashboard, accent: 'sky' },
        editing: 'team',
        blocks,
        filtersBar: compact([
          r.owner && {
            id: 'f_resp',
            label: labelOf(table, r.owner),
            source: table.slug,
            field: r.owner,
            kind: 'select',
          },
          r.date && {
            id: 'f_fecha',
            label: labelOf(table, r.date),
            source: table.slug,
            field: r.date,
            kind: 'date_range',
          },
        ]),
      });
      break;
    }
    case 'detalle_linea_tiempo': {
      blocks.push({
        id: 'buscar',
        type: 'table',
        width: 'full',
        tracker: table.slug,
        title: `Buscar en ${label.toLowerCase()}`,
        columns: compact([r.title, r.status, r.date, r.owner ?? r.client, r.amount]).slice(0, 5),
        sort: { field: r.date ?? 'created_at', dir: 'desc' },
        limit: 50,
        searchable: true,
        design: d(0),
      });
      blocks.push(detailBlock(table, r, { related, design: d(1) }));
      spec = specBase({ theme: { ...THEME.dashboard }, blocks });
      break;
    }
    case 'mapa_con_lista': {
      blocks.push({
        id: 'mapa',
        type: 'map',
        width: 'full',
        tracker: table.slug,
        title: `${label} en el mapa`,
        locationField: r.location,
        titleField: r.title,
        ...(r.subtitle ? { subtitleField: r.subtitle } : {}),
        ...(r.status ? { colorField: r.status } : {}),
        design: d(0),
      });
      blocks.push({
        ...cardsBlock(table, r, {
          chips: r.status ? ['status'] : [],
          pageSize: 8,
          title: 'En la lista',
        }),
        design: d(1),
      });
      blocks.push(detailBlock(table, r, { related, design: d(2) }));
      spec = specBase({ theme: { ...THEME.dashboard, accent: 'sky' }, blocks });
      break;
    }
    case 'agenda': {
      blocks.push({
        id: 'agenda',
        type: 'calendar',
        width: 'full',
        tracker: table.slug,
        title: 'Agenda',
        dateField: r.date,
        labelField: r.title,
        ...(r.status ? { colorField: r.status } : {}),
        ...(r.time ? { timeField: r.time } : {}),
        mode: 'week',
        modes: ['day', 'week', 'month'],
        design: d(0),
      });
      blocks.push({
        ...cardsBlock(table, r, {
          id: 'hoy',
          chips: ['today'],
          pageSize: 6,
          title: 'Hoy',
          searchable: false,
        }),
        design: d(1),
      });
      blocks.push(detailBlock(table, r, { related, design: d(2) }));
      spec = specBase({ theme: { ...THEME.dashboard }, blocks });
      break;
    }
    case 'panel_gerencial': {
      const kpi = (tone?: string): Raw =>
        r.date ? d(0, tone) : { ...d(0, tone), variant: 'number' };
      const cmp = r.date ? { compare: 'previous_period', period: 'month', dateField: r.date } : {};
      blocks.push(metric('registros', table, label, { ...cmp, design: kpi() }));
      if (r.amount)
        blocks.push(
          metric('total_monto', table, `Total de ${labelOf(table, r.amount).toLowerCase()}`, {
            aggregate: 'sum',
            field: r.amount,
            format: amountFormat,
            ...cmp,
            tone: 'emerald',
            design: kpi('emerald'),
          }),
        );
      if (r.status && firstState)
        blocks.push(
          metric('por_revisar', table, `En «${firstState}»`, {
            filters: [{ field: r.status, op: 'eq', value: firstState }],
            tone: 'amber',
            goodWhen: 'down',
            design: kpi('amber'),
          }),
        );
      const aggregate = r.amount
        ? { aggregate: 'sum', field: r.amount, format: amountFormat }
        : { aggregate: 'count' };
      if (r.date)
        blocks.push({
          id: 'evolucion',
          type: 'chart',
          width: 'half',
          tracker: table.slug,
          title: r.amount ? `${labelOf(table, r.amount)} por mes` : `${label} por mes`,
          chart: 'line',
          groupBy: r.date,
          bucket: 'month',
          ...aggregate,
          design: { ...d(1), variant: 'area' },
        });
      const splitBy = r.status ?? r.owner;
      if (splitBy)
        blocks.push({
          id: 'reparto',
          type: 'chart',
          width: r.date ? 'half' : 'full',
          tracker: table.slug,
          title: `Por ${labelOf(table, splitBy).toLowerCase()}`,
          chart: r.status === splitBy ? 'donut' : 'bar',
          groupBy: splitBy,
          ...aggregate,
          design: { ...d(1), variant: r.status === splitBy ? 'donut' : 'bar' },
        });
      const rank = r.owner ?? r.client;
      if (rank)
        blocks.push({
          id: 'ranking',
          type: 'progress',
          width: 'full',
          tracker: table.slug,
          title: `Ranking por ${labelOf(table, rank).toLowerCase()}`,
          groupBy: rank,
          ...aggregate,
          limit: 8,
          design: d(2),
        });
      spec = specBase({
        theme: { ...THEME.dashboard, header: 'plain', style: 'clean' },
        blocks,
        refreshSeconds: 60,
      });
      break;
    }
    case 'portal_cliente': {
      if (r.status && firstState)
        blocks.push(
          metric(
            'abiertos',
            table,
            'En trámite',
            { filters: [{ field: r.status, op: 'eq', value: firstState }], design: d(0) },
            'half',
          ),
        );
      if (r.amount)
        blocks.push(
          metric(
            'valor',
            table,
            `Total de ${labelOf(table, r.amount).toLowerCase()}`,
            { aggregate: 'sum', field: r.amount, format: amountFormat, design: d(0) },
            'half',
          ),
        );
      blocks.push({
        ...cardsBlock(table, r, {
          chips: r.status ? ['status'] : [],
          pageSize: 9,
          title: 'Tus registros',
        }),
        design: d(1),
      });
      blocks.push(
        detailBlock(table, r, {
          related,
          design: d(2),
          timeline: { show: ['created', 'changes', 'approvals', 'files'], limit: 20 },
        }),
      );
      spec = specBase({
        theme: { ...THEME.dashboard, header: 'hero' },
        blocks,
        subtitle: 'Aquí ves el avance de lo tuyo.',
      });
      break;
    }
    case 'pantalla_planta_tv': {
      const page1: string[] = [];
      const page2: string[] = [];
      if (r.date) {
        blocks.push(
          metric('hoy', table, `${label} de hoy`, {
            filters: [{ field: r.date, op: 'last_days', value: 1 }],
            design: d(0),
          }),
        );
        page1.push('hoy');
      }
      if (r.status && firstState) {
        blocks.push(
          metric('por_hacer', table, `En «${firstState}»`, {
            filters: [{ field: r.status, op: 'eq', value: firstState }],
            tone: 'amber',
            design: d(0, 'amber'),
          }),
        );
        page1.push('por_hacer');
      }
      if (r.amount) {
        blocks.push(
          metric('monto', table, labelOf(table, r.amount), {
            aggregate: 'sum',
            field: r.amount,
            format: amountFormat,
            tone: 'emerald',
            design: d(0, 'emerald'),
          }),
        );
        page1.push('monto');
      }
      if (!page1.length) {
        blocks.push(metric('total', table, label, { design: d(0) }));
        page1.push('total');
      }
      if (r.status) {
        blocks.push({
          id: 'reparto',
          type: 'chart',
          width: 'half',
          tracker: table.slug,
          title: `Por ${labelOf(table, r.status).toLowerCase()}`,
          chart: 'donut',
          groupBy: r.status,
          design: d(1),
        });
        blocks.push({
          id: 'tablero',
          type: 'board',
          width: 'half',
          tracker: table.slug,
          title: 'En la planta',
          groupBy: r.status,
          cardFields: compact([r.date]).slice(0, 1),
          limit: 12,
          openRecord: false,
          design: d(2),
        });
        page2.push('reparto', 'tablero');
      }
      spec = specBase({
        theme: { layout: 'tv', style: 'dark-panel', tv: { rotateSeconds: 15, clock: true } },
        blocks,
        pages: compact([
          { id: 'resumen', title: 'Resumen', blockIds: page1 },
          page2.length > 0 && { id: 'estado', title: 'Estado', blockIds: page2 },
        ]),
      });
      break;
    }
  }

  const title =
    options.title ?? (pattern.id === 'registrar' ? `Registrar ${label.toLowerCase()}` : pattern.name);
  const slug = slugify(title) || pattern.id;
  const wantDesign = options.includeDesign !== false;
  const tries = wantDesign ? [spec, stripDesign(spec)] : [stripDesign(spec)];
  let parsed: ViewSpec | null = null;
  let hadDesign = false;
  let lastError = '';
  for (const [i, candidate] of tries.entries()) {
    const res = viewSpecSchema.safeParse(candidate);
    if (res.success) {
      parsed = res.data;
      hadDesign = wantDesign && i === 0 && parsed.blocks.some((b) => 'design' in b);
      break;
    }
    lastError = res.error.issues
      .slice(0, 3)
      .map((x) => `${x.path.join('.')}: ${x.message}`)
      .join('; ');
  }
  if (!parsed)
    return {
      ok: false,
      missing: [],
      reason: `El patrón «${pattern.name}» no encajó con «${table.name}»: ${lastError}`,
    };
  return {
    ok: true,
    hadDesign,
    used: r,
    screen: {
      title: title.slice(0, 60),
      slug: slug.slice(0, 47),
      icon: pattern.icon,
      roles: options.roles ?? [],
      spec: parsed,
    },
  };
}
