import { ValidationError } from '@cortex/core';
import type { SheetData } from '../kb/spreadsheets';
import { type ProposedField, proposeTableFromSheet } from '../table-sync/propose';
import type { DuplicateRule } from '../trackers/duplicates';
import type { TrackerField } from '../trackers/schema';
import { type DocTypeGroup, groupByDocType, matchDocType } from './doc-types';
import { type DriveAccess, UnreadableFileError, readDriveFile } from './engine';
import {
  type FolderInventory,
  INVENTORY_LIST_FACTOR,
  INVENTORY_MAX_DEPTH,
  INVENTORY_MAX_FILES,
  classifyFile,
  inventoryMarkdown,
  inventoryOf,
  listFolderTree,
} from './inventory';
import {
  type PathPattern,
  type PathRule,
  describeValues,
  detectPathPatterns,
  suggestPathFields,
} from './path-fields';
import {
  CARPETA_KEY,
  type FolderFile,
  REVIEW_FIELD,
  REVIEW_FIELD_KEY,
  SHEET_ROWS_PER_FILE,
  SHEET_SAMPLE_ROWS,
  compact,
} from './plan';
import { type DocRole, proposeTableFromFolder } from './propose';

/**
 * PROPONER LA TABLA DE UNA CARPETA ANTES DE CREARLA.
 *
 * Mismo principio que con una hoja suelta (table-sync/propose.ts): cuando
 * alguien da una carpeta de Drive como fuente, Cortex no crea la tabla a
 * ciegas. MIRA qué hay (inventario), LEE una muestra y propone los campos con
 * el porqué; la persona aprueba o corrige y recién ahí se crea.
 *
 *   - HOJAS. Si hay hojas de cálculo, la propuesta sale de sus encabezados y
 *     sus datos (`proposeTableFromSheet`: tipos, obligatorios, clave,
 *     duplicados). Varias hojas con encabezados parecidos se UNEN en una
 *     tabla; si hay hojas con otros encabezados no se mezclan: se dice y se
 *     pregunta si una tabla o varias.
 *   - DOCUMENTOS (PDF, Word, fotos). Un documento de muestra lo lee el modelo y
 *     propone sus campos; se agregan a los de las hojas, marcados `fromDocument`
 *     (los de hojas llevan `sourceColumn`).
 *   - SUBCARPETAS. Si el inventario las encuentra se incluyen por defecto, y la
 *     tabla gana un campo «Carpeta» que se llena solo con la subcarpeta de cada
 *     archivo (suele ser el cliente, el mes o el lote).
 *   - TIPOS DE DOCUMENTO. Los archivos se agrupan por tipo (nombre sin números +
 *     extensión): «prealerta · pdf», «manifiesto aerolineas · xlsx», «formulario
 *     dian · pdf». De cada tipo de documento se lee UNA muestra y el modelo dice
 *     si es la base de las filas, un complemento o no sirve para lo que la
 *     persona pidió (`goal`). Una fila se puede llenar con varios tipos,
 *     unidos por la clave. Si es ambiguo, la propuesta trae una pregunta corta
 *     (`ask`) para hacerla con ask_choice en vez de adivinar.
 *   - CAMPOS DE LA RUTA. Si los nombres de las subcarpetas siguen un patrón
 *     («33. FEDEX 3325 07102026») se proponen campos que se llenan con sus piezas
 *     (path-fields.ts); un nombre que no encaja queda vacío y por revisar.
 *   - CARPETAS GRANDES. Pasados 5.000 archivos se mira una MUESTRA estratificada
 *     (inventory.ts) y se dice cuántos hay de verdad; las hojas enormes se leen
 *     por su encabezado y las primeras 300 filas.
 */

export interface FolderFieldProposal extends TrackerField {
  /** Encabezado de la hoja del que sale (hojas). */
  sourceColumn?: string;
  /** Se lee de los documentos (PDF, Word, fotos). */
  fromDocument?: boolean;
  /** Dónde está el dato en el documento. */
  hint?: string;
  /** Se llena solo con la subcarpeta del archivo. */
  fromFolder?: boolean;
  /** Se llena con una pieza del NOMBRE de una subcarpeta (nivel y pieza). */
  fromPath?: PathRule;
  /** Los tipos de documento de los que se lee, cada uno con su pista (vacío = de cualquiera). */
  docTypes?: Array<{ type: string; hint: string }>;
  why: string[];
  samples: string[];
}

export interface FolderProposal {
  folder: { id: string; name: string };
  recursive: boolean;
  inventory: FolderInventory;
  name: string;
  description: string;
  fields: FolderFieldProposal[];
  /** Claves (de campo) que identifican un registro. */
  keyFields: string[];
  keyWhy: string;
  duplicates: (DuplicateRule & { why: string }) | null;
  sheetFiles: number;
  sheetRows: number;
  /** De qué documento de muestra salieron los campos de documentos. */
  sampleDocument: string | null;
  /** Los tipos de documento de la carpeta, con conteo, ejemplo y el papel de cada uno. */
  types: TypeSummary[];
  /** Los tipos de las hojas que se leen sin modelo (para `@tipos`). */
  sheetTypes: string[];
  /** Patrones detectados en los nombres de las subcarpetas. */
  pathPatterns: PathPattern[];
  /** Si es ambiguo, la pregunta corta para hacer con ask_choice (pregunta ≤180, opciones ≤64). */
  ask: AskSuggestion | null;
  notes: string[];
  markdown: string;
}

export type TypeRole = DocRole | 'hoja' | 'sin_leer' | 'sin_muestra';

export interface TypeSummary {
  /** El identificador del tipo (el que usa la sincronización). */
  key: string;
  label: string;
  count: number;
  /** En cuántas subcarpetas aparece. */
  folders: number;
  example: string;
  role: TypeRole;
  why: string;
}

export interface AskSuggestion {
  question: string;
  options: string[];
}

export interface SheetSample {
  file: FolderFile;
  tab: SheetData;
}

export interface DocProposal {
  name: string;
  description: string;
  fields: TrackerField[];
  extract: Array<{ key: string; hint: string }>;
  keyFields: string[];
  sampleName: string;
  /** Qué papel juega este tipo de documento respecto a lo que la persona pidió. */
  role?: DocRole;
  roleWhy?: string;
}

/** La propuesta de un tipo de documento, con el grupo del que salió la muestra. */
export interface TypedDoc {
  group: DocTypeGroup;
  proposal: DocProposal;
}

const MAX_DOC_TYPES = 5;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const MAX_SHEET_FILES = 8;
const SIMILAR = 0.8;

function headerSet(tab: SheetData): Set<string> {
  return new Set(
    (tab.rows[0] ?? []).map((h) => compact(String(h ?? ''))).filter((h) => h.length > 0),
  );
}

function similar(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const h of a) if (b.has(h)) both += 1;
  return both / new Set([...a, ...b]).size >= SIMILAR;
}

const ROLE_TEXT: Record<TypeRole, string> = {
  base: 'base de las filas',
  complementario: 'complementa',
  no_sirve: 'no sirve para lo pedido',
  hoja: 'hoja (fila por fila)',
  sin_leer: 'no se puede leer',
  sin_muestra: 'sin muestra',
};

const TYPE_NAME: Record<string, string> = {
  text: 'Texto',
  longtext: 'Texto largo',
  number: 'Número',
  money: 'Dinero',
  date: 'Fecha',
  time: 'Hora',
  checkbox: 'Sí / No',
  select: 'Lista',
};

/**
 * Junta lo que se leyó (puro, para poder probarlo sin Drive ni modelo): las
 * hojas con encabezados compatibles en una sola propuesta, los campos de los
 * documentos, el campo «Carpeta», la clave y la regla de duplicados.
 */
export function combineFolderProposal(input: {
  folder: { id: string; name: string };
  recursive: boolean;
  inventory: FolderInventory;
  sheets: SheetSample[];
  /** Una sola propuesta de documentos (sin tipos). */
  doc: DocProposal | null;
  /** Una propuesta por tipo de documento (reemplaza a `doc`). */
  docs?: TypedDoc[];
  /** Lo que la persona dijo que quiere en la tabla. */
  goal?: string;
  notes?: string[];
}): FolderProposal {
  const notes = [...(input.notes ?? [])];
  const { inventory } = input;

  // 1. Las hojas: agrupar por encabezados parecidos; manda el grupo con más filas.
  type Group = { sig: Set<string>; items: Array<SheetSample & { rows: number }> };
  const groups: Group[] = [];
  for (const s of input.sheets) {
    const sig = headerSet(s.tab);
    if (sig.size < 2 || s.tab.rows.length < 2) continue;
    const item = { ...s, rows: (s.tab.totalRows ?? s.tab.rows.length) - 1 };
    const g = groups.find((x) => similar(x.sig, sig));
    if (g) g.items.push(item);
    else groups.push({ sig, items: [item] });
  }
  const total = (g: Group) => g.items.reduce((n, i) => n + i.rows, 0);
  groups.sort((a, b) => total(b) - total(a));
  const main = groups[0];
  const rest = groups.slice(1);
  if (rest.length)
    notes.push(
      `Hay ${rest.length} grupo(s) de hojas con encabezados distintos a los de la tabla principal (${rest
        .map((g) =>
          g.items
            .map((i) => `«${i.file.name}»`)
            .slice(0, 2)
            .join(', '),
        )
        .join(
          '; ',
        )}). No las mezclé: dime si quieres una sola tabla (y qué hacer con esas columnas) o una tabla por tipo de hoja.`,
    );

  let fields: FolderFieldProposal[] = [];
  let keyFields: string[] = [];
  let keyWhy = '';
  let duplicates: FolderProposal['duplicates'] = null;
  let sheetRows = 0;
  let sheetFiles = 0;
  let carpetaInKey = false;

  if (main) {
    const biggest = main.items.reduce((a, b) => (b.rows > a.rows ? b : a));
    const p = proposeTableFromSheet(biggest.tab);
    sheetRows = total(main);
    sheetFiles = new Set(main.items.map((i) => i.file.id)).size;
    notes.push(...p.notes.filter((n) => n !== p.keyWhy));
    fields = p.fields.map(({ sourceColumn, ...f }: ProposedField) => ({
      ...f,
      ...(sourceColumn ? { sourceColumn } : {}),
    }));
    keyFields = p.keyColumns
      .map((c) => fields.find((f) => f.sourceColumn === c)?.key)
      .filter((k): k is string => Boolean(k));
    keyWhy = p.keyWhy;
    if (p.duplicates) {
      const { why, ...rule } = p.duplicates;
      duplicates = { ...rule, why };
    }

    // ¿El mismo código se repite entre archivos o entre carpetas?
    const keyHeader = p.keyColumns[0];
    if (keyHeader) {
      const seen = new Map<string, { files: Set<string>; paths: Set<string> }>();
      for (const it of main.items) {
        const col = (it.tab.rows[0] ?? []).findIndex((h) => String(h ?? '').trim() === keyHeader);
        if (col < 0) continue;
        for (const r of it.tab.rows.slice(1)) {
          const v = String(r[col] ?? '')
            .trim()
            .toLowerCase();
          if (!v) continue;
          const e = seen.get(v) ?? { files: new Set<string>(), paths: new Set<string>() };
          e.files.add(it.file.id);
          e.paths.add(it.file.path ?? '');
          seen.set(v, e);
        }
      }
      const repeatsFiles = [...seen.values()].some((e) => e.files.size > 1);
      const repeatsFolders = [...seen.values()].some((e) => e.paths.size > 1);
      if (repeatsFolders && input.recursive) {
        keyWhy += ' El mismo valor aparece en carpetas distintas: agregué la Carpeta a la clave.';
        carpetaInKey = true;
      } else if (repeatsFiles)
        notes.push(
          'El mismo valor de la clave aparece en archivos distintos de la misma carpeta; cada archivo guarda sus filas por separado (la clave incluye el archivo), pero conviene revisar si son el mismo registro.',
        );
    }
  }

  // 2. Los documentos: uno por tipo de documento (o la propuesta única de antes).
  const docList: Array<{ doc: DocProposal; group?: DocTypeGroup }> = input.docs?.length
    ? input.docs.map((d) => ({ doc: d.proposal, group: d.group }))
    : input.doc
      ? [{ doc: input.doc }]
      : [];
  const used = docList.filter((d) => d.doc.role !== 'no_sirve');
  const typed = docList.some((d) => d.group);
  let sampleDocument: string | null = null;
  if (docList.length && !used.length)
    notes.push(
      'Ningún tipo de documento de la carpeta trae los datos que pediste; si me equivoco, dime cuál sí.',
    );
  if (used.length) sampleDocument = used.map((d) => d.doc.sampleName).join(', ');
  for (const { doc, group } of used) {
    for (const f of doc.fields) {
      if (f.key === REVIEW_FIELD_KEY) continue;
      const hint = doc.extract.find((e) => e.key === f.key)?.hint ?? '';
      const twin = fields.find((x) => x.key === f.key || compact(x.label) === compact(f.label));
      const entry = group ? { type: group.key, hint } : null;
      if (twin) {
        twin.fromDocument = true;
        if (hint && !twin.hint) twin.hint = hint;
        if (entry) twin.docTypes = [...(twin.docTypes ?? []), entry];
        twin.why.push(
          group ? `también se lee de «${group.label}»` : 'también se lee de los documentos',
        );
        continue;
      }
      fields.push({
        ...f,
        fromDocument: true,
        ...(hint ? { hint } : {}),
        ...(entry ? { docTypes: [entry] } : {}),
        why: [
          group
            ? `se lee de «${group.label}» (muestra: «${doc.sampleName}»)`
            : `se lee de los documentos (muestra: «${doc.sampleName}»)`,
        ],
        samples: [],
      });
    }
  }
  if (used.length && !keyFields.length) {
    // La clave que comparten todos los tipos usados: así sus filas se unen.
    const shared = used
      .map((d) => d.doc.keyFields.filter((k) => fields.some((f) => f.key === k)))
      .reduce((a, b) => a.filter((k) => b.includes(k)));
    keyFields = shared.length
      ? shared
      : (used[0]?.doc.keyFields ?? []).filter((k) => fields.some((f) => f.key === k));
    if (keyFields.length)
      keyWhy =
        used.length > 1 && shared.length
          ? 'Es el dato que identifica cada documento y que traen todos los tipos que uso: por él se unen en una sola fila.'
          : 'Es el dato que identifica cada documento en la muestra (casi siempre su número).';
    if (used.length > 1 && !shared.length)
      notes.push(
        'Los tipos de documento no comparten un dato que los identifique, así que no se pueden unir en una sola fila. Dime con qué dato se relacionan (la guía, el vuelo…).',
      );
  }
  if (used.length > 1 && typed)
    notes.push(
      `Cada fila se llena con varios tipos de documento (${used
        .map((d) => d.group?.label)
        .filter(Boolean)
        .join('; ')}): los que traen el mismo valor de la clave se unen.`,
    );

  // 3. La subcarpeta y los campos que salen del NOMBRE de las subcarpetas.
  const carpeta =
    input.recursive && inventory.folders.length > 0 && !fields.some((f) => f.key === CARPETA_KEY);
  const pathPatterns = input.recursive ? detectPathPatterns(inventory.folders) : [];
  for (const sug of suggestPathFields(pathPatterns)) {
    if (fields.some((f) => f.key === sug.key)) continue;
    const pat = pathPatterns.find((p) => p.level === sug.rule.level) as PathPattern;
    fields.push({
      key: sug.key,
      label: sug.label,
      type: sug.type,
      required: false,
      fromPath: sug.rule,
      why: [
        `sale del nombre de las subcarpetas de nivel ${pat.level} (${pat.shape}); si un nombre no lo trae queda vacío y la fila por revisar`,
      ],
      samples: pat.examples
        .map((e) => e.values[sug.rule.part])
        .filter((v): v is string | number => v !== undefined)
        .map(String),
    });
  }
  for (const p of pathPatterns)
    notes.push(
      `Los nombres de las subcarpetas de nivel ${p.level} siguen un patrón (${p.shape}), en ${p.matching} de ${p.names}: ${p.examples
        .map((e) => `«${e.name}» → ${describeValues(e.values)}`)
        .join(
          '; ',
        )}.${p.unmatched.length ? ` No encajan: ${p.unmatched.map((n) => `«${n}»`).join(', ')} (quedan vacíos y por revisar).` : ''} Ponles el nombre que corresponde (aerolínea, vuelo, cliente…) o quita los que no necesites.`,
    );
  if (carpeta) {
    fields.push({
      key: CARPETA_KEY,
      label: 'Carpeta',
      type: 'text',
      required: false,
      fromFolder: true,
      why: [
        'se llena sola con la subcarpeta de cada archivo (ruta relativa); suele ser el cliente, el mes o el lote',
      ],
      samples: inventory.folders.slice(0, 3).map((f) => f.path),
    });
  }
  if (carpetaInKey && carpeta && !keyFields.includes(CARPETA_KEY)) keyFields.push(CARPETA_KEY);

  // 4. Duplicados de una clave sin sheets: el mismo número con otra fecha.
  const idKeys = keyFields.filter((k) => k !== CARPETA_KEY);
  if (!duplicates && !main && idKeys.length === 1) {
    const dateField = fields.find((f) => f.type === 'date' && f.key !== idKeys[0] && !f.fromPath);
    if (dateField) {
      keyFields = [...keyFields.filter((k) => k !== dateField.key), dateField.key];
      const status = fields.find((f) => f.key === 'estado');
      if (!status)
        fields.push({
          key: 'estado',
          label: 'Estado',
          type: 'select',
          required: false,
          options: ['Pendiente', 'Duplicado'],
          why: ['nuevo: para marcar los duplicados (no viene de los archivos)'],
          samples: [],
        });
      else if (status.type === 'select' && !status.options?.includes('Duplicado'))
        status.options = [...(status.options ?? []), 'Duplicado'];
      duplicates = {
        key: idKeys[0] as string,
        distinctBy: dateField.key,
        flagField: 'estado',
        flagValue: 'Duplicado',
        why: `Puede llegar el mismo documento con otra fecha; con «${dateField.label}» en la clave nacen dos filas y la segunda se marca «Duplicado» para revisar.`,
      };
      keyWhy += ` Agregué «${dateField.label}» a la clave por el riesgo de duplicados.`;
    }
  }
  if (!main && carpeta && !keyFields.includes(CARPETA_KEY))
    notes.push(
      'Si el mismo número puede repetirse entre carpetas (clientes distintos), agrégale «Carpeta» a la clave.',
    );

  // 5. El campo de revisión y el tope de campos.
  if (!fields.some((f) => f.key === REVIEW_FIELD_KEY))
    fields.push({
      ...REVIEW_FIELD,
      why: ['marca las filas que hay que revisar (lo dudoso o lo que falta)'],
      samples: [],
    });
  if (fields.length > 20) {
    const keep = (f: FolderFieldProposal) =>
      keyFields.includes(f.key) ||
      f.key === REVIEW_FIELD_KEY ||
      f.key === CARPETA_KEY ||
      Boolean(f.fromPath) ||
      f.key === duplicates?.flagField;
    const optional = fields.filter((f) => !keep(f));
    const drop = new Set(optional.slice(optional.length - (fields.length - 20)).map((f) => f.key));
    notes.push(
      `La tabla admite 20 campos: dejé fuera ${[...drop].join(', ')}. Dime si prefieres otros.`,
    );
    fields = fields.filter((f) => !drop.has(f.key));
  }
  if (!keyFields.length)
    keyWhy =
      'Ninguna columna o dato identifica cada registro por sí solo; dime cuál usar (o qué combinación).';

  if (!fields.some((f) => f.sourceColumn || f.fromDocument))
    throw new ValidationError(
      'No encontré en la carpeta nada que pueda leer para proponer los campos: ni hojas con datos ni documentos legibles.',
    );

  // Los tipos de documento de la carpeta y el papel de cada uno.
  const sheetTypes = main ? groupByDocType(main.items.map((i) => i.file)).map((g) => g.key) : [];
  const byGroup = new Map(docList.flatMap((d) => (d.group ? [[d.group.key, d] as const] : [])));
  const types: TypeSummary[] = groupByDocType(inventory.all ?? [])
    .slice(0, 12)
    .map((g) => {
      const base = {
        key: g.key,
        label: g.label,
        count: g.count,
        folders: g.folders,
        example: g.examples[0]?.name ?? '',
      };
      const cls = classifyFile(g.mimeType).class;
      if (cls === 'unreadable')
        return { ...base, role: 'sin_leer' as const, why: 'no se puede leer' };
      if (cls === 'sheet')
        return sheetTypes.some((t) => matchDocType(g.examples[0]?.name ?? '', g.mimeType, [t]))
          ? { ...base, role: 'hoja' as const, why: 'se lee fila por fila, sin modelo' }
          : {
              ...base,
              role: 'sin_muestra' as const,
              why: 'encabezados distintos o no se alcanzó a leer',
            };
      const d = byGroup.get(g.key);
      if (!d)
        return { ...base, role: 'sin_muestra' as const, why: 'no leí una muestra de este tipo' };
      return { ...base, role: d.doc.role ?? ('base' as const), why: d.doc.roleWhy ?? '' };
    });

  // Si hay varios tipos que cuentan y la persona no dijo qué quiere, se pregunta.
  let ask: AskSuggestion | null = null;
  const readable = types.filter((t) => t.role !== 'sin_leer').reduce((n, t) => n + t.count, 0);
  const counting = types.filter(
    (t) =>
      (t.role === 'base' || t.role === 'complementario' || t.role === 'hoja') &&
      t.count >= Math.max(3, readable * 0.1),
  );
  if ((typed || input.docs) && !input.goal?.trim() && counting.length >= 2) {
    ask = {
      question: clip(
        `La carpeta «${input.folder.name}» mezcla ${counting.length} tipos de documento. ¿Cuál llena cada fila de la tabla?`,
        180,
      ),
      options: [
        ...counting.slice(0, 3).map((t) => clip(`Sólo ${t.label}`, 64)),
        'Todos, unidos por la clave',
        'Otra cosa: te digo cuál',
      ].slice(0, 5),
    };
  }

  const out: FolderProposal = {
    folder: input.folder,
    recursive: input.recursive,
    inventory,
    name: (main ? input.folder.name : (used[0]?.doc.name ?? input.folder.name)).slice(0, 80),
    description: (
      used[0]?.doc.description || `Se llena sola desde la carpeta «${input.folder.name}».`
    ).slice(0, 300),
    fields,
    keyFields,
    keyWhy,
    duplicates,
    sheetFiles,
    sheetRows,
    sampleDocument,
    types,
    sheetTypes,
    pathPatterns,
    ask,
    notes,
    markdown: '',
  };
  out.markdown = folderProposalMarkdown(out);
  return out;
}

/** La propuesta como tabla para el chat. */
export function folderProposalMarkdown(p: FolderProposal): string {
  const lines = [inventoryMarkdown(p.inventory, p.folder.name), ''];
  if (p.recursive && p.inventory.folders.length)
    lines.push(
      `_Incluí las subcarpetas (${p.inventory.folders.length}, hasta ${p.inventory.maxDepth} niveles, ${p.inventory.maxFiles} archivos como máximo). Si prefieres sólo la carpeta principal, dímelo._`,
      '',
    );
  if (p.sheetFiles)
    lines.push(
      `Leí ${p.sheetFiles} hoja(s) con ${p.sheetRows} filas: cada fila será un registro, sin pasar por el modelo.`,
    );
  if (p.sampleDocument)
    lines.push(
      `De los documentos (PDF, Word, fotos) el modelo lee los campos marcados «documento»; muestras: ${p.sampleDocument}.`,
    );
  if (p.types.length > 1 || p.types.some((t) => t.role === 'no_sirve')) {
    lines.push(
      '',
      'Tipos de documento que hay en la carpeta:',
      '',
      '| Tipo | Cuántos | Ejemplo | Papel |',
      '|---|---|---|---|',
      ...p.types.map(
        (t) =>
          `| ${t.label} | ${t.count} (en ${t.folders} subcarpeta${t.folders === 1 ? '' : 's'}) | ${t.example} | ${ROLE_TEXT[t.role]}${t.why ? `: ${t.why}` : ''} |`,
      ),
    );
  }
  lines.push(
    '',
    'Te propongo esta tabla:',
    '',
    '| Campo | Tipo | De dónde sale | Ejemplo |',
    '|---|---|---|---|',
    ...p.fields.map((f) => {
      const from = [
        f.sourceColumn ? `hoja: «${f.sourceColumn}»` : '',
        f.fromDocument
          ? f.docTypes?.length
            ? `documento (${f.docTypes.map((d) => d.type.replace(/\.[a-z0-9]+$/, '')).join('; ')})`
            : 'documento'
          : '',
        f.fromFolder ? 'subcarpeta' : '',
        f.fromPath ? `nombre de subcarpeta (nivel ${f.fromPath.level}: ${f.fromPath.part})` : '',
        !f.sourceColumn && !f.fromDocument && !f.fromFolder && !f.fromPath
          ? 'lo llena el equipo'
          : '',
      ]
        .filter(Boolean)
        .join(' + ');
      return `| ${f.label} | ${TYPE_NAME[f.type] ?? f.type} | ${from} | ${f.samples[0] ?? ''} |`;
    }),
    '',
    p.keyFields.length
      ? `**Cada registro se identifica por:** ${p.keyFields
          .map((k) => p.fields.find((f) => f.key === k)?.label ?? k)
          .join(' + ')}. ${p.keyWhy}`
      : `**Falta decidir:** ${p.keyWhy}`,
    ...(p.duplicates ? [`**Duplicados:** ${p.duplicates.why}`] : []),
    ...p.notes.map((n) => `_${n}_`),
    ...(p.ask
      ? [
          '',
          `**Antes de crearla necesito que elijas** (pregúntalo con ask_choice, no adivines): ${p.ask.question} Opciones: ${p.ask.options.map((o) => `«${o}»`).join(', ')}.`,
        ]
      : []),
    '',
    'Lo que ya estaba en la hoja y se borre después no se borra de la tabla.',
    '',
    '¿La creo así o quieres cambiar algo (nombres, tipos, clave, subcarpetas)?',
  );
  return lines.join('\n');
}

export interface ProposeFolderDeps {
  /** Abre una hoja como pestañas, sólo el comienzo (por defecto, Drive). */
  loadSheets?: (file: FolderFile) => Promise<SheetData[]>;
  /** Propone con documentos de muestra de UN tipo (por defecto, el modelo). */
  proposeDocs?: (
    files: FolderFile[],
    opts: { goal?: string; typeLabel?: string },
  ) => Promise<DocProposal>;
}

/** Hojas de muestra: repartidas entre los tipos de hoja, no las primeras que salgan. */
function sheetSamples(sheets: FolderFile[], max: number): FolderFile[] {
  const groups = groupByDocType(sheets).map((g) => [...g.examples]);
  const out: FolderFile[] = [];
  for (let round = 0; out.length < max && round < 3; round++)
    for (const g of groups) {
      const f = g[round];
      if (f && out.length < max) out.push(f);
    }
  return out;
}

/**
 * Lee la carpeta y propone la tabla. Sólo lee: no crea nada.
 * `includeSubfolders`: undefined = sí si hay subcarpetas; false = sólo la raíz.
 * `goal`: lo que la persona quiere ver en la tabla (decide qué tipo es la base).
 */
export async function proposeFromDriveFolder(
  drive: DriveAccess,
  folder: { id: string; name: string },
  opts: { includeSubfolders?: boolean; goal?: string } = {},
  deps: ProposeFolderDeps = {},
): Promise<FolderProposal> {
  const dims = { maxDepth: INVENTORY_MAX_DEPTH, maxFiles: INVENTORY_MAX_FILES };
  const wantsDeep = opts.includeSubfolders !== false;
  const tree = await listFolderTree(drive, folder.id, {
    recursive: wantsDeep,
    maxDepth: dims.maxDepth,
    maxFiles: dims.maxFiles * INVENTORY_LIST_FACTOR,
  });
  const recursive = wantsDeep && tree.folders.length > 0;
  const inventory = inventoryOf(tree, { recursive, ...dims });

  const loadSheets =
    deps.loadSheets ??
    (async (file: FolderFile) => {
      // Una hoja enorme no se rechaza: para proponer basta el encabezado y las primeras filas.
      const read = await readDriveFile(drive, file, {
        sheetRows: true,
        sheetRowLimit: SHEET_SAMPLE_ROWS,
      });
      if (read.kind !== 'sheet') throw new UnreadableFileError('No es una hoja.');
      return read.sheets;
    });
  const notes: string[] = [];
  const sheets: SheetSample[] = [];
  const picked = sheetSamples(inventory.sheets, MAX_SHEET_FILES);
  let cut = 0;
  for (const file of picked) {
    try {
      for (const tab of await loadSheets(file)) {
        if (tab.truncated) cut += 1;
        sheets.push({ file, tab });
      }
    } catch (err) {
      notes.push(`No pude abrir la hoja «${file.name}»: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  if (inventory.sheets.length > picked.length)
    notes.push(
      `Para proponer leí ${picked.length} de las ${inventory.sheets.length} hojas, repartidas entre sus tipos.`,
    );
  if (cut)
    notes.push(
      `${cut} pestaña(s) son muy largas: para proponer leí el encabezado y las primeras ${SHEET_SAMPLE_ROWS} filas; la sincronización lee más (hasta ${SHEET_ROWS_PER_FILE.toLocaleString('es-CO')} filas por archivo).`,
    );

  // Un tipo de documento por vez: una muestra de cada uno, los más numerosos primero.
  const docs: TypedDoc[] = [];
  const docFiles = [...inventory.all].filter((f) => {
    const c = classifyFile(f.mimeType).class;
    return c === 'document' || c === 'image';
  });
  const groups = groupByDocType(docFiles);
  const propose = deps.proposeDocs ?? ((files, o) => proposeTableFromFolder(drive, files, o));
  for (const group of groups.slice(0, MAX_DOC_TYPES)) {
    const files = docFiles.filter((f) => matchDocType(f.name, f.mimeType, [group.key]));
    try {
      const proposal = await propose(files, { goal: opts.goal, typeLabel: group.label });
      docs.push({ group, proposal });
    } catch (err) {
      notes.push(
        `No pude leer una muestra de «${group.label}» para proponer sus campos: ${(err as Error).message.slice(0, 160)}`,
      );
    }
  }
  if (groups.length > MAX_DOC_TYPES)
    notes.push(
      `Hay ${groups.length} tipos de documento; leí una muestra de los ${MAX_DOC_TYPES} más numerosos (${groups
        .slice(MAX_DOC_TYPES)
        .reduce((n, g) => n + g.count, 0)} archivos de los otros no entran).`,
    );
  return combineFolderProposal({
    folder,
    recursive,
    inventory,
    sheets,
    doc: null,
    docs,
    goal: opts.goal,
    notes,
  });
}
