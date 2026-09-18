import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { SheetData, SheetValue } from '@cortex/agent-tools/src/kb/spreadsheets';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { feedFingerprint } from './fingerprint';
import { FEED_COLUMNS, ownedFeed } from './store';

const MAX_SOURCES = 3;
const MAX_ROWS = 1000;
const MAX_HEADERS = 120;
const MAX_CELL_CHARS = 1000;

export const CombinedColumnSchema = z.object({
  sourceId: z.string().uuid(),
  sheetIndex: z.number().int().min(0).max(19),
  column: z.number().int().min(0).max(499),
  header: z
    .string()
    .min(1)
    .max(240)
    .refine((header) => header.trim().length > 0, 'La clave necesita un encabezado visible.'),
});

export const CombinedMappingSchema = z.object({
  left: CombinedColumnSchema,
  right: CombinedColumnSchema,
});

export const CombinedApprovedHeadersSchema = z.object({
  sourceId: z.string().uuid(),
  sheetIndex: z.number().int().min(0).max(19),
  headers: z.array(z.string().max(240)).min(1).max(MAX_HEADERS),
});

export const CombinedSourceConfigSchema = z
  .object({
    version: z.literal(1),
    sourceIds: z.array(z.string().uuid()).min(2).max(MAX_SOURCES),
    approvedHeaders: z.array(CombinedApprovedHeadersSchema).min(2).max(MAX_SOURCES),
    mappings: z
      .array(CombinedMappingSchema)
      .min(1)
      .max(MAX_SOURCES - 1),
    maxRows: z.number().int().min(1).max(MAX_ROWS).optional(),
  })
  .superRefine((config, context) => {
    const ids = new Set(config.sourceIds);
    if (ids.size !== config.sourceIds.length)
      context.addIssue({
        code: 'custom',
        message: 'Una fuente no puede aparecer dos veces.',
        path: ['sourceIds'],
      });
    if (config.mappings.length !== config.sourceIds.length - 1)
      context.addIssue({
        code: 'custom',
        message:
          'Cada fuente secundaria necesita una clave explícita frente a la fuente principal.',
        path: ['mappings'],
      });
    const approved = new Map<string, CombinedApprovedHeaders>();
    for (const item of config.approvedHeaders) {
      if (!ids.has(item.sourceId))
        context.addIssue({
          code: 'custom',
          message: 'Hay encabezados aprobados para una fuente ajena.',
          path: ['approvedHeaders'],
        });
      if (approved.has(item.sourceId))
        context.addIssue({
          code: 'custom',
          message: 'Cada fuente necesita un único esquema aprobado.',
          path: ['approvedHeaders'],
        });
      approved.set(item.sourceId, item);
    }
    if (approved.size !== ids.size)
      context.addIssue({
        code: 'custom',
        message: 'Falta el esquema aprobado de una fuente.',
        path: ['approvedHeaders'],
      });

    const seenSecondary = new Set<string>();
    const anchor = config.sourceIds[0];
    let anchorColumn: CombinedColumn | null = null;
    for (const [index, mapping] of config.mappings.entries()) {
      const left = mapping.left;
      const right = mapping.right;
      if (left.sourceId === right.sourceId) {
        context.addIssue({
          code: 'custom',
          message: 'La clave debe cruzar dos fuentes distintas.',
          path: ['mappings', index],
        });
        continue;
      }
      if (!ids.has(left.sourceId) || !ids.has(right.sourceId)) {
        context.addIssue({
          code: 'custom',
          message: 'La clave apunta a una fuente que no está incluida.',
          path: ['mappings', index],
        });
        continue;
      }
      if (left.sourceId !== anchor && right.sourceId !== anchor) {
        context.addIssue({
          code: 'custom',
          message: 'Las claves deben conectar cada fuente con la primera fuente.',
          path: ['mappings', index],
        });
        continue;
      }
      const secondary = left.sourceId === anchor ? right : left;
      const currentAnchor = left.sourceId === anchor ? left : right;
      if (
        anchorColumn &&
        (anchorColumn.sheetIndex !== currentAnchor.sheetIndex ||
          anchorColumn.column !== currentAnchor.column ||
          anchorColumn.header !== currentAnchor.header)
      )
        context.addIssue({
          code: 'custom',
          message: 'Las tres fuentes deben usar la misma clave de la fuente principal.',
          path: ['mappings', index],
        });
      anchorColumn ??= currentAnchor;
      if (seenSecondary.has(secondary.sourceId))
        context.addIssue({
          code: 'custom',
          message: 'Una fuente secundaria sólo puede tener una clave.',
          path: ['mappings', index],
        });
      seenSecondary.add(secondary.sourceId);
      for (const side of [left, right]) {
        const schema = approved.get(side.sourceId);
        if (!schema) continue;
        if (side.sheetIndex !== schema.sheetIndex)
          context.addIssue({
            code: 'custom',
            message: 'La hoja de la clave no coincide con el esquema aprobado.',
            path: ['mappings', index],
          });
        if (side.column >= schema.headers.length)
          context.addIssue({
            code: 'custom',
            message: 'La clave apunta a una columna inexistente en el esquema aprobado.',
            path: ['mappings', index],
          });
        if (schema.headers[side.column] !== side.header)
          context.addIssue({
            code: 'custom',
            message: 'El encabezado aprobado de la clave cambió.',
            path: ['mappings', index],
          });
      }
    }
    for (const sourceId of config.sourceIds.slice(1)) {
      if (!seenSecondary.has(sourceId))
        context.addIssue({
          code: 'custom',
          message: 'Falta una clave para una fuente secundaria.',
          path: ['mappings'],
        });
    }
  });

export type CombinedSourceConfig = z.infer<typeof CombinedSourceConfigSchema>;
export type CombinedColumn = z.infer<typeof CombinedColumnSchema>;
export type CombinedMapping = z.infer<typeof CombinedMappingSchema>;
export type CombinedApprovedHeaders = z.infer<typeof CombinedApprovedHeadersSchema>;

export type CombinedDependencySnapshot = {
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  attachmentId: string;
  contentHash: string | null;
  purgeAt: string;
  lastChangedAt: string | null;
  sheetIndex: number;
  sheetName: string;
  headers: string[];
  rowCount: number;
  truncated: boolean;
};

export type CombinedRowProvenance = {
  sourceId: string;
  sourceName: string;
  attachmentId: string;
  sheetIndex: number;
  sheetName: string;
  rowIndex: number;
  quote: string;
};

export type CombinedPreviewRow = {
  rowIndex: number;
  status: 'matched' | 'unmatched' | 'ambiguous';
  key: string | null;
  values: Array<{
    sourceId: string;
    sourceName: string;
    rowIndexes: number[];
    cells: Array<{ column: number; header: string; value: SheetValue }>;
  }>;
  provenance: CombinedRowProvenance[];
  reasons: string[];
};

export type CombinedPreview = {
  version: 1;
  sourceId: string | null;
  status: 'ready' | 'blocked';
  config: CombinedSourceConfig;
  dependencies: CombinedDependencySnapshot[];
  headers: string[];
  rows: CombinedPreviewRow[];
  summary: { matched: number; unmatched: number; ambiguous: number; truncated: boolean };
  errors: string[];
};

export type CombinedSourceSummary = {
  id: string;
  kind: 'file' | 'text' | 'url' | 'google_sheet' | 'api' | 'combined';
  name: string;
  latestAttachmentId: string | null;
  status: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  error: string | null;
  config?: CombinedSourceConfig | null;
  tables: Array<{ index: number; name: string; rowCount: number; headers: string[] }>;
};

type SourceRow = {
  sourceId: string;
  sourceName: string;
  attachmentId: string;
  sheetIndex: number;
  sheetName: string;
  rowIndex: number;
  row: SheetValue[];
  key: string;
};

type LoadedDependency = CombinedDependencySnapshot & {
  sourceUpdatedAt: string | null;
  sourceLastChangedAt: string | null;
  table: SheetData;
};

type SourceRowPayload = {
  id: string;
  organization_id: string;
  actor_id: string;
  kind: string;
  name: string;
  latest_attachment_id: string | null;
  enabled: boolean;
  status: string;
  error: string | null;
  updated_at: string;
  last_changed_at: string | null;
  config: unknown;
};

type AttachmentPayload = {
  id: string;
  organization_id: string;
  created_by: string;
  feed_source_id: string | null;
  feed_kind: string | null;
  filename: string;
  feed_content_hash: string | null;
  feed_tables: unknown;
  extracted_text: string | null;
  feed_truncated: boolean;
  purge_at: string;
};

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

function canonicalIdentity(value: unknown): string {
  // The user selected the key. Preserve its exact value after stringifying the
  // cell; case, accents, and whitespace differences remain different keys.
  return value === null || value === undefined ? '' : String(value);
}

function safeCell(value: unknown): SheetValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, MAX_CELL_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return clean(value).slice(0, MAX_CELL_CHARS);
}

function safeSheet(value: unknown): value is SheetData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { name?: unknown }).name === 'string' &&
      Array.isArray((value as { rows?: unknown }).rows) &&
      (value as { rows: unknown[] }).rows.every((row) => Array.isArray(row)),
  );
}

function observedHeaders(table: SheetData): string[] {
  // Keep one sentinel column beyond the approved maximum so a newly appended
  // header fails schema equality instead of disappearing through truncation.
  return (table.rows[0] ?? []).slice(0, MAX_HEADERS + 1).map(headerValue);
}

function headersEqual(actual: string[], approved: string[]) {
  return (
    actual.length === approved.length && actual.every((header, index) => header === approved[index])
  );
}

function hashConfig(config: CombinedSourceConfig) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function sourceTableSummary(
  tables: unknown,
): Array<{ index: number; name: string; rowCount: number; headers: string[] }> {
  if (!Array.isArray(tables)) return [];
  return tables.flatMap((value, index) => {
    if (!safeSheet(value)) return [];
    return [
      {
        index,
        name: clean(value.name) || `Hoja ${index + 1}`,
        rowCount: Math.max(0, value.rows.length - 1),
        headers: observedHeaders(value),
      },
    ];
  });
}

function normalizeConfig(input: unknown): CombinedSourceConfig {
  const parsed = CombinedSourceConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new CombinedSourceError(
      parsed.error.issues[0]?.message ?? 'El mapeo combinado no es válido.',
      422,
    );
  return { ...parsed.data, maxRows: parsed.data.maxRows ?? MAX_ROWS };
}

export class CombinedSourceError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'CombinedSourceError';
  }
}

function orientMappings(config: CombinedSourceConfig) {
  const anchor = config.sourceIds[0];
  return config.mappings.map((mapping) => {
    if (mapping.left.sourceId === anchor) return mapping;
    return { left: mapping.right, right: mapping.left };
  });
}

async function loadDependencies(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
  config: CombinedSourceConfig,
): Promise<{ dependencies: LoadedDependency[]; errors: string[] }> {
  const now = Date.now();
  const sourceResult = await db
    .from('feed_sources')
    .select(
      'id,organization_id,actor_id,kind,name,latest_attachment_id,enabled,status,error,updated_at,last_changed_at,config',
    )
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .in('id', config.sourceIds);
  if (sourceResult.error)
    throw new CombinedSourceError('No se pudieron cargar las fuentes combinadas.', 503);
  const sourceRows = (sourceResult.data ?? []) as unknown as SourceRowPayload[];
  const byId = new Map(sourceRows.map((source) => [source.id, source]));
  const errors: string[] = [];
  for (const sourceId of config.sourceIds) {
    const source = byId.get(sourceId);
    if (!source) errors.push(`La fuente ${sourceId} no existe en este espacio.`);
    else if (!source.enabled) errors.push(`La fuente “${source.name}” está desactivada.`);
    else if (source.kind === 'combined')
      errors.push(`La fuente “${source.name}” no puede depender de otra combinación.`);
    else if (!source.latest_attachment_id)
      errors.push(`La fuente “${source.name}” todavía no tiene una captura.`);
  }
  const attachmentIds = sourceRows.flatMap((source) => source.latest_attachment_id ?? []);
  const attachmentResult = attachmentIds.length
    ? await db
        .from('chat_attachments')
        .select(
          'id,organization_id,created_by,feed_source_id,feed_kind,filename,feed_content_hash,feed_tables,extracted_text,feed_truncated,purge_at',
        )
        .eq('organization_id', organizationId)
        .eq('created_by', actorId)
        .in('id', attachmentIds)
    : { data: [], error: null };
  if (attachmentResult.error)
    throw new CombinedSourceError('No se pudieron cargar las capturas de Feed.', 503);
  const attachments = new Map(
    ((attachmentResult.data ?? []) as unknown as AttachmentPayload[]).map((attachment) => [
      attachment.id,
      attachment,
    ]),
  );
  const approved = new Map(config.approvedHeaders.map((item) => [item.sourceId, item]));
  const dependencies: LoadedDependency[] = [];
  for (const sourceId of config.sourceIds) {
    const source = byId.get(sourceId);
    if (!source || !source.latest_attachment_id) continue;
    const attachment = attachments.get(source.latest_attachment_id);
    if (!attachment || !attachment.feed_kind || Date.parse(attachment.purge_at) <= now) {
      errors.push(`La captura actual de “${source.name}” venció o dejó de estar disponible.`);
      continue;
    }
    if (attachment.feed_truncated) {
      errors.push(
        `La captura actual de “${source.name}” está truncada y no se puede cruzar con seguridad.`,
      );
      continue;
    }
    const schema = approved.get(sourceId);
    const tables = Array.isArray(attachment.feed_tables)
      ? attachment.feed_tables.filter(safeSheet)
      : [];
    const table = schema ? tables[schema.sheetIndex] : undefined;
    if (!schema || !table) {
      errors.push(`La hoja aprobada de “${source.name}” ya no existe.`);
      continue;
    }
    const headers = observedHeaders(table);
    if (!headersEqual(headers, schema.headers)) {
      errors.push(`Cambió el esquema de “${source.name}”. Revisa los encabezados antes de cruzar.`);
      continue;
    }
    dependencies.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      attachmentId: attachment.id,
      contentHash: attachment.feed_content_hash,
      purgeAt: attachment.purge_at,
      lastChangedAt: source.last_changed_at,
      sourceUpdatedAt: source.updated_at,
      sourceLastChangedAt: source.last_changed_at,
      sheetIndex: schema.sheetIndex,
      sheetName: clean(table.name) || `Hoja ${schema.sheetIndex + 1}`,
      headers,
      rowCount: Math.max(0, table.rows.length - 1),
      truncated: attachment.feed_truncated,
      table,
    });
  }
  return { dependencies, errors };
}

function quoteRow(row: SourceRow, headers: string[]): string {
  return row.row
    .slice(0, headers.length)
    .map((value, column) => {
      const literal = value === null || value === undefined ? '' : String(value);
      return `${headers[column] || `Columna ${column + 1}`}=${literal}`;
    })
    .join(' · ')
    .slice(0, 1200);
}

function buildPreviewRows(
  config: CombinedSourceConfig,
  dependencies: LoadedDependency[],
): { rows: CombinedPreviewRow[]; headers: string[]; truncated: boolean } {
  const maxRows = config.maxRows ?? MAX_ROWS;
  const mappings = orientMappings(config);
  const keyColumn = new Map<string, CombinedColumn>();
  for (const mapping of mappings) {
    keyColumn.set(mapping.left.sourceId, mapping.left);
    keyColumn.set(mapping.right.sourceId, mapping.right);
  }
  const buckets = new Map<string, Map<string, SourceRow[]>>();
  const keyByGroup = new Map<string, string>();
  const groupsByKey = new Map<string, string>();
  const order: string[] = [];
  for (const dependency of dependencies) {
    const column = keyColumn.get(dependency.sourceId);
    if (!column) continue;
    const rows = dependency.table.rows.slice(1, maxRows + 1).map((row, offset) => ({
      sourceId: dependency.sourceId,
      sourceName: dependency.sourceName,
      attachmentId: dependency.attachmentId,
      sheetIndex: dependency.sheetIndex,
      sheetName: dependency.sheetName,
      rowIndex: offset + 1,
      row,
      key: canonicalIdentity(row[column.column]),
    }));
    for (const item of rows) {
      let groupKey: string;
      if (item.key) {
        groupKey = groupsByKey.get(item.key) ?? `key:${order.length}`;
        groupsByKey.set(item.key, groupKey);
        keyByGroup.set(groupKey, item.key);
      } else {
        groupKey = `missing:${item.sourceId}:${item.rowIndex}`;
      }
      let group = buckets.get(groupKey);
      if (!group) {
        group = new Map();
        buckets.set(groupKey, group);
        order.push(groupKey);
      }
      const sourceRows = group.get(item.sourceId) ?? [];
      sourceRows.push(item);
      group.set(item.sourceId, sourceRows);
    }
  }
  const headers = [
    'Clave exacta',
    ...dependencies.flatMap((dependency) =>
      dependency.headers.map((header) => `${dependency.sourceName} · ${header}`),
    ),
  ];
  const rows: CombinedPreviewRow[] = [];
  let rowIndex = 0;
  for (const groupKey of order) {
    if (rows.length >= maxRows) break;
    const group = buckets.get(groupKey);
    if (!group) continue;
    const key = keyByGroup.get(groupKey) ?? null;
    const values: CombinedPreviewRow['values'] = [];
    const provenance: CombinedRowProvenance[] = [];
    const reasons: string[] = [];
    let ambiguous = false;
    let unmatched = Boolean(key === null);
    for (const dependency of dependencies) {
      const sourceRows = group.get(dependency.sourceId) ?? [];
      if (!sourceRows.length) {
        unmatched = true;
        reasons.push(`No hay coincidencia exacta en “${dependency.sourceName}”.`);
        continue;
      }
      if (sourceRows.length > 1) {
        ambiguous = true;
        reasons.push(
          `La clave exacta aparece ${sourceRows.length} veces en “${dependency.sourceName}”.`,
        );
      }
      values.push({
        sourceId: dependency.sourceId,
        sourceName: dependency.sourceName,
        rowIndexes: sourceRows.map((item) => item.rowIndex),
        cells: dependency.headers.map((header, column) => ({
          column,
          header,
          value: safeCell(sourceRows[0]?.row[column]),
        })),
      });
      for (const sourceRow of sourceRows.slice(0, 20)) {
        provenance.push({
          sourceId: sourceRow.sourceId,
          sourceName: sourceRow.sourceName,
          attachmentId: sourceRow.attachmentId,
          sheetIndex: sourceRow.sheetIndex,
          sheetName: sourceRow.sheetName,
          rowIndex: sourceRow.rowIndex,
          quote: quoteRow(sourceRow, dependency.headers),
        });
      }
    }
    rows.push({
      rowIndex,
      status: ambiguous ? 'ambiguous' : unmatched ? 'unmatched' : 'matched',
      key,
      values,
      provenance,
      reasons: key === null ? ['Falta una clave explícita en una fila.'] : reasons,
    });
    rowIndex += 1;
  }
  return {
    rows,
    headers,
    truncated:
      order.length > rows.length ||
      dependencies.some(
        (dependency) =>
          dependency.rowCount > maxRows ||
          (dependency.table.rows[0]?.length ?? 0) > MAX_HEADERS ||
          dependency.table.rows
            .slice(1, maxRows + 1)
            .some((row) =>
              row.some((value) => typeof value === 'string' && value.length > MAX_CELL_CHARS),
            ),
      ),
  };
}

function buildCombinedTable(preview: CombinedPreview): SheetData {
  const rows: SheetValue[][] = [preview.headers];
  for (const item of preview.rows) {
    const cells: SheetValue[] = [item.key];
    for (const dependency of preview.dependencies) {
      const values = item.values.find((value) => value.sourceId === dependency.sourceId);
      for (const [column, header] of dependency.headers.entries()) {
        const cell = values?.cells.find((candidate) => candidate.column === column);
        cells.push(
          !values
            ? null
            : values.rowIndexes.length > 1
              ? `[Ambigua: ${values.rowIndexes.length} filas]`
              : safeCell(cell?.value),
        );
      }
    }
    rows.push(cells);
  }
  return { name: 'Combinación', rows };
}

function buildCaptureText(preview: CombinedPreview): string {
  const lines = [
    'Vista combinada privada de Feed.',
    `Dependencias: ${preview.dependencies.map((dependency) => `${dependency.sourceName} (${dependency.attachmentId})`).join(', ')}.`,
    `Resultado: ${preview.summary.matched} coincidentes, ${preview.summary.unmatched} sin coincidencia, ${preview.summary.ambiguous} ambiguas.`,
  ];
  for (const row of preview.rows.slice(0, 200)) {
    lines.push(
      `Fila ${row.rowIndex + 1} · ${row.status} · ${row.key ?? 'sin clave'} · ${row.provenance.map((item) => `${item.sourceName} fila ${item.rowIndex + 1}: ${item.quote}`).join(' || ')}`,
    );
  }
  return lines.join('\n').slice(0, 200_000);
}

function dependencyJson(preview: CombinedPreview) {
  return preview.dependencies.map((dependency) => ({
    sourceId: dependency.sourceId,
    sourceName: dependency.sourceName,
    sourceKind: dependency.sourceKind,
    attachmentId: dependency.attachmentId,
    contentHash: dependency.contentHash,
    purgeAt: dependency.purgeAt,
    lastChangedAt: dependency.lastChangedAt,
    sheetIndex: dependency.sheetIndex,
    sheetName: dependency.sheetName,
    headers: dependency.headers,
    rowCount: dependency.rowCount,
    truncated: dependency.truncated,
  }));
}

function provenanceJson(preview: CombinedPreview) {
  return preview.rows.map((row) => ({
    // Activation candidates use the data row's one-based index. The combined
    // preview is zero-based for rendering, so persist the source row number
    // expected by activation_runs and by the SQL commit fence.
    rowIndex: row.rowIndex + 1,
    status: row.status,
    key: row.key,
    reasons: row.reasons,
    provenance: row.provenance,
  }));
}

async function writeDependencyLedger(
  db: SupabaseClient,
  organizationId: string,
  sourceId: string,
  attachmentId: string,
  dependencies: CombinedDependencySnapshot[],
) {
  const deleted = await db
    .from('feed_combined_dependencies')
    .delete()
    .eq('organization_id', organizationId)
    .eq('combined_source_id', sourceId)
    .eq('combined_attachment_id', attachmentId);
  if (deleted.error)
    throw new CombinedSourceError('No se pudo actualizar la procedencia de la combinación.', 503);
  if (!dependencies.length) return;
  const inserted = await db.from('feed_combined_dependencies').insert(
    dependencies.map((dependency) => ({
      organization_id: organizationId,
      combined_source_id: sourceId,
      combined_attachment_id: attachmentId,
      dependency_source_id: dependency.sourceId,
      dependency_attachment_id: dependency.attachmentId,
      dependency_content_hash: dependency.contentHash,
      dependency_purge_at: dependency.purgeAt,
      dependency_last_changed_at: dependency.lastChangedAt,
    })),
  );
  if (inserted.error)
    throw new CombinedSourceError('No se pudo guardar la procedencia de la combinación.', 503);
}

async function saveCapture(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
  sourceId: string,
  sourceName: string,
  config: CombinedSourceConfig,
  preview: CombinedPreview,
) {
  const table = buildCombinedTable(preview);
  if (preview.summary.truncated)
    throw new CombinedSourceError(
      'La combinación supera los límites de captura y no se puede guardar parcialmente.',
      409,
    );
  const text = buildCaptureText(preview);
  const fingerprint = feedFingerprint({
    text,
    tables: [table],
    sourceUrl: `combined:${sourceId}:${hashConfig(config)}`,
    truncated: preview.summary.truncated,
  });
  const duplicate = await ownedFeed(db, actorId)
    .eq('feed_content_hash', fingerprint)
    .eq('feed_source_id', sourceId)
    .maybeSingle();
  if (duplicate.error)
    throw new CombinedSourceError('No se pudo comprobar el historial combinado.', 503);
  const now = new Date().toISOString();
  let attachmentId: string;
  let entry: unknown;
  let deduplicated = false;
  if (duplicate.data) {
    attachmentId = duplicate.data.id;
    entry = duplicate.data;
    deduplicated = true;
  } else {
    const count = await db
      .from('chat_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('created_by', actorId)
      .not('feed_kind', 'is', null)
      .gt('purge_at', now);
    if (count.error)
      throw new CombinedSourceError('No se pudo comprobar la capacidad de Feed.', 503);
    if ((count.count ?? 0) >= 100)
      throw new CombinedSourceError(
        'Tu Feed tiene 100 entradas. Elimina alguna antes de combinar.',
        422,
      );
    attachmentId = randomUUID();
    const body = Buffer.from(text);
    const inserted = await db
      .from('chat_attachments')
      .insert({
        id: attachmentId,
        conversation_id: null,
        disposition: 'turn',
        filename: `Combinación · ${sourceName}`.slice(0, 240),
        mime: 'text/markdown',
        byte_size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        feed_content_hash: fingerprint,
        extracted_text: text,
        file_path: null,
        created_by: actorId,
        feed_kind: 'combined',
        source_url: null,
        feed_tables: [table],
        feed_truncated: preview.summary.truncated,
        feed_source_id: sourceId,
        feed_combined_dependencies: dependencyJson(preview),
        feed_combined_provenance: provenanceJson(preview),
      })
      .select(FEED_COLUMNS)
      .single();
    if (inserted.error || !inserted.data)
      throw new CombinedSourceError('No se pudo guardar la captura combinada.', 503);
    entry = inserted.data;
  }
  await writeDependencyLedger(db, organizationId, sourceId, attachmentId, preview.dependencies);
  const updated = await db
    .from('feed_sources')
    .update({
      latest_attachment_id: attachmentId,
      last_checked_at: now,
      last_changed_at: now,
      status: 'ok',
      error: null,
      updated_at: now,
    })
    .eq('id', sourceId)
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .eq('enabled', true)
    .select('id')
    .maybeSingle();
  if (updated.error || !updated.data)
    throw new CombinedSourceError(
      'La combinación fue capturada, pero la fuente quedó desactivada.',
      409,
    );
  return { sourceId, attachmentId, entry, preview, deduplicated };
}

export async function previewCombinedSource(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
  input: unknown,
  sourceId: string | null = null,
): Promise<CombinedPreview> {
  const config = normalizeConfig(input);
  const loaded = await loadDependencies(db, actorId, organizationId, config);
  const canPreview =
    loaded.errors.length === 0 && loaded.dependencies.length === config.sourceIds.length;
  if (!canPreview) {
    return {
      version: 1,
      sourceId,
      status: 'blocked',
      config,
      dependencies: loaded.dependencies.map(
        ({
          table: _table,
          sourceUpdatedAt: _sourceUpdatedAt,
          sourceLastChangedAt: _sourceLastChangedAt,
          ...dependency
        }) => dependency,
      ),
      headers: [],
      rows: [],
      summary: { matched: 0, unmatched: 0, ambiguous: 0, truncated: false },
      errors: loaded.errors,
    };
  }
  const built = buildPreviewRows(config, loaded.dependencies);
  const summary = { matched: 0, unmatched: 0, ambiguous: 0 };
  for (const row of built.rows) summary[row.status] += 1;
  const errors = built.truncated
    ? ['La captura supera los límites de Feed; revisa el tamaño antes de guardarla.']
    : [];
  return {
    version: 1,
    sourceId,
    status: errors.length ? 'blocked' : 'ready',
    config,
    dependencies: loaded.dependencies.map(
      ({
        table: _table,
        sourceUpdatedAt: _sourceUpdatedAt,
        sourceLastChangedAt: _sourceLastChangedAt,
        ...dependency
      }) => dependency,
    ),
    headers: built.headers,
    rows: built.rows,
    summary: { ...summary, truncated: built.truncated },
    errors,
  };
}

export async function saveCombinedSource(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
  name: string,
  input: unknown,
) {
  const config = normalizeConfig(input);
  const sourceName = clean(name).slice(0, 240);
  if (!sourceName) throw new CombinedSourceError('Ponle un nombre a la fuente combinada.', 422);
  const preview = await previewCombinedSource(db, actorId, organizationId, config);
  if (preview.status !== 'ready')
    throw new CombinedSourceError(
      preview.errors[0] ?? 'Las fuentes no están listas para combinar.',
      409,
    );
  const configHash = hashConfig(config);
  const existing = await db
    .from('feed_sources')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .eq('kind', 'combined')
    .eq('config_hash', configHash)
    .maybeSingle();
  if (existing.error)
    throw new CombinedSourceError('No se pudo comprobar la fuente combinada.', 503);
  let sourceId = existing.data?.id as string | undefined;
  if (!sourceId) {
    const inserted = await db
      .from('feed_sources')
      .insert({
        organization_id: organizationId,
        actor_id: actorId,
        kind: 'combined',
        name: sourceName,
        config,
        config_hash: configHash,
        status: 'ready',
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data)
      throw new CombinedSourceError('No se pudo guardar la fuente combinada.', 503);
    sourceId = inserted.data.id as string;
  } else {
    const renamed = await db
      .from('feed_sources')
      .update({ name: sourceName, updated_at: new Date().toISOString() })
      .eq('id', sourceId)
      .eq('organization_id', organizationId)
      .eq('actor_id', actorId);
    if (renamed.error)
      throw new CombinedSourceError('No se pudo actualizar la fuente combinada.', 503);
  }
  return saveCapture(db, actorId, organizationId, sourceId, sourceName, config, {
    ...preview,
    sourceId,
  });
}

export async function refreshCombinedSource(
  db: SupabaseClient,
  actorId: string,
  sourceId: string,
  organizationId: string,
  refreshDependency?: (sourceId: string) => Promise<unknown>,
) {
  const selected = await db
    .from('feed_sources')
    .select('id,organization_id,actor_id,kind,name,config,enabled')
    .eq('id', sourceId)
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (selected.error || !selected.data)
    throw new CombinedSourceError('La fuente combinada no existe.', 404);
  if (selected.data.kind !== 'combined')
    throw new CombinedSourceError('La fuente elegida no es una combinación.', 409);
  if (!selected.data.enabled)
    throw new CombinedSourceError('La fuente combinada está desactivada.', 409);
  const config = normalizeConfig(selected.data.config);
  if (refreshDependency) {
    for (const dependencyId of config.sourceIds) await refreshDependency(dependencyId);
  }
  try {
    const preview = await previewCombinedSource(db, actorId, organizationId, config, sourceId);
    if (preview.status !== 'ready')
      throw new CombinedSourceError(
        preview.errors[0] ?? 'Una dependencia no está disponible.',
        409,
      );
    return await saveCapture(
      db,
      actorId,
      organizationId,
      sourceId,
      selected.data.name,
      config,
      preview,
    );
  } catch (error) {
    await db
      .from('feed_sources')
      .update({
        status: 'error',
        error: (error instanceof Error ? error.message : 'No se pudo actualizar.').slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', sourceId)
      .eq('organization_id', organizationId)
      .eq('actor_id', actorId)
      .eq('enabled', true);
    throw error;
  }
}

export async function listCombinedSources(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
) {
  const sources = await db
    .from('feed_sources')
    .select(
      'id,organization_id,actor_id,kind,name,latest_attachment_id,status,last_checked_at,last_changed_at,error,enabled,config',
    )
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (sources.error)
    throw new CombinedSourceError('No se pudieron cargar las fuentes de Feed.', 503);
  const rows = (sources.data ?? []) as unknown as Array<
    SourceRowPayload & { last_checked_at?: string | null }
  >;
  const attachmentIds = rows.flatMap((row) => row.latest_attachment_id ?? []);
  const attachments = attachmentIds.length
    ? await db
        .from('chat_attachments')
        .select('id,feed_tables')
        .eq('organization_id', organizationId)
        .eq('created_by', actorId)
        .in('id', attachmentIds)
    : { data: [], error: null };
  if (attachments.error)
    throw new CombinedSourceError('No se pudieron cargar los esquemas de Feed.', 503);
  const tableByAttachment = new Map(
    ((attachments.data ?? []) as Array<{ id: string; feed_tables: unknown }>).map((row) => [
      row.id,
      sourceTableSummary(row.feed_tables),
    ]),
  );
  return rows.map(
    (row): CombinedSourceSummary => ({
      id: row.id,
      kind: row.kind as CombinedSourceSummary['kind'],
      name: row.name,
      latestAttachmentId: row.latest_attachment_id,
      status: row.status,
      enabled: row.enabled,
      lastCheckedAt: row.last_checked_at ?? null,
      lastChangedAt: row.last_changed_at,
      error: row.error,
      config: row.kind === 'combined' ? (row.config as CombinedSourceConfig) : null,
      tables: tableByAttachment.get(row.latest_attachment_id ?? '') ?? [],
    }),
  );
}

export function canonicalCombinedIdentity(value: unknown) {
  return canonicalIdentity(value);
}
