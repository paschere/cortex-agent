import { ValidationError } from '@cortex/core';
import type { SheetData } from '../kb/spreadsheets';
import { type ProposedField, proposeTableFromSheet } from '../table-sync/propose';
import type { DuplicateRule } from '../trackers/duplicates';
import type { TrackerField } from '../trackers/schema';
import { type DriveAccess, UnreadableFileError, readDriveFile } from './engine';
import { type FolderInventory, inventoryMarkdown, inventoryOf, listFolderTree } from './inventory';
import { CARPETA_KEY, type FolderFile, REVIEW_FIELD, REVIEW_FIELD_KEY, compact } from './plan';
import { proposeTableFromFolder } from './propose';

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
  notes: string[];
  markdown: string;
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
}

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
  doc: DocProposal | null;
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
    const item = { ...s, rows: s.tab.rows.length - 1 };
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

  // 2. Los documentos.
  let sampleDocument: string | null = null;
  if (input.doc) {
    sampleDocument = input.doc.sampleName;
    for (const f of input.doc.fields) {
      if (f.key === REVIEW_FIELD_KEY) continue;
      const hint = input.doc.extract.find((e) => e.key === f.key)?.hint ?? '';
      const twin = fields.find((x) => x.key === f.key || compact(x.label) === compact(f.label));
      if (twin) {
        twin.fromDocument = true;
        if (hint) twin.hint = hint;
        twin.why.push('también se lee de los documentos');
        continue;
      }
      fields.push({
        ...f,
        fromDocument: true,
        ...(hint ? { hint } : {}),
        why: [`se lee de los documentos (muestra: «${input.doc.sampleName}»)`],
        samples: [],
      });
    }
    if (!keyFields.length) {
      keyFields = input.doc.keyFields.filter((k) => fields.some((f) => f.key === k));
      if (keyFields.length)
        keyWhy = 'Es el dato que identifica cada documento en la muestra (casi siempre su número).';
    }
  }

  // 3. La subcarpeta.
  const carpeta =
    input.recursive && inventory.folders.length > 0 && !fields.some((f) => f.key === CARPETA_KEY);
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
    const dateField = fields.find((f) => f.type === 'date' && f.key !== idKeys[0]);
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

  const out: FolderProposal = {
    folder: input.folder,
    recursive: input.recursive,
    inventory,
    name: (main ? input.folder.name : (input.doc?.name ?? input.folder.name)).slice(0, 80),
    description: (
      input.doc?.description || `Se llena sola desde la carpeta «${input.folder.name}».`
    ).slice(0, 300),
    fields,
    keyFields,
    keyWhy,
    duplicates,
    sheetFiles,
    sheetRows,
    sampleDocument,
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
      `De los documentos (PDF, Word, fotos) el modelo lee los campos marcados «documento»; muestra: «${p.sampleDocument}».`,
    );
  lines.push(
    '',
    'Te propongo esta tabla:',
    '',
    '| Campo | Tipo | De dónde sale | Ejemplo |',
    '|---|---|---|---|',
    ...p.fields.map((f) => {
      const from = [
        f.sourceColumn ? `hoja: «${f.sourceColumn}»` : '',
        f.fromDocument ? 'documento' : '',
        f.fromFolder ? 'subcarpeta' : '',
        !f.sourceColumn && !f.fromDocument && !f.fromFolder ? 'lo llena el equipo' : '',
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
    '',
    'Lo que ya estaba en la hoja y se borre después no se borra de la tabla.',
    '',
    '¿La creo así o quieres cambiar algo (nombres, tipos, clave, subcarpetas)?',
  );
  return lines.join('\n');
}

export interface ProposeFolderDeps {
  /** Abre una hoja como pestañas (por defecto, Drive). */
  loadSheets?: (file: FolderFile) => Promise<SheetData[]>;
  /** Propone con documentos de muestra (por defecto, el modelo). */
  proposeDocs?: (files: FolderFile[]) => Promise<DocProposal>;
}

/**
 * Lee la carpeta y propone la tabla. Sólo lee: no crea nada.
 * `includeSubfolders`: undefined = sí si hay subcarpetas; false = sólo la raíz.
 */
export async function proposeFromDriveFolder(
  drive: DriveAccess,
  folder: { id: string; name: string },
  opts: { includeSubfolders?: boolean } = {},
  deps: ProposeFolderDeps = {},
): Promise<FolderProposal> {
  const dims = { maxDepth: 3, maxFiles: 500 };
  const wantsDeep = opts.includeSubfolders !== false;
  const tree = await listFolderTree(drive, folder.id, { recursive: wantsDeep, ...dims });
  const recursive = wantsDeep && tree.folders.length > 0;
  const inventory = inventoryOf(tree, { recursive, ...dims });

  const loadSheets =
    deps.loadSheets ??
    (async (file: FolderFile) => {
      const read = await readDriveFile(drive, file, { sheetRows: true });
      if (read.kind !== 'sheet') throw new UnreadableFileError('No es una hoja.');
      return read.sheets;
    });
  const notes: string[] = [];
  const sheets: SheetSample[] = [];
  for (const file of inventory.sheets.slice(0, MAX_SHEET_FILES)) {
    try {
      for (const tab of await loadSheets(file)) sheets.push({ file, tab });
    } catch (err) {
      notes.push(`No pude abrir la hoja «${file.name}»: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  if (inventory.sheets.length > MAX_SHEET_FILES)
    notes.push(
      `Sólo leí ${MAX_SHEET_FILES} de las ${inventory.sheets.length} hojas para proponer.`,
    );

  let doc: DocProposal | null = null;
  const docFiles = [...inventory.documents, ...inventory.images];
  if (docFiles.length) {
    try {
      doc = await (deps.proposeDocs ?? ((files) => proposeTableFromFolder(drive, files)))(docFiles);
    } catch (err) {
      notes.push(
        `No pude leer un documento de muestra para proponer sus campos: ${(err as Error).message.slice(0, 160)}`,
      );
    }
  }
  return combineFolderProposal({ folder, recursive, inventory, sheets, doc, notes });
}
