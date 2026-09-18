import 'server-only';

import { createHash } from 'node:crypto';
import type { SheetData } from '@cortex/agent-tools/src/kb/spreadsheets';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type CombinedApprovedHeaders,
  type CombinedColumn,
  type CombinedMapping,
  type CombinedSourceConfig,
  CombinedSourceError,
} from './combined-source';
import { recommendFeedUse } from './intelligence';

type MetadataSource = {
  id: string;
  kind: string;
  name: string;
  latest_attachment_id: string | null;
  enabled: boolean;
  status: string;
  error: string | null;
  config: unknown;
};

type MetadataAttachment = {
  id: string;
  filename: string;
  feed_tables: unknown;
  feed_truncated: boolean;
  purge_at: string;
};

export type FeedSourceMetadata = {
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  attachmentId: string;
  attachmentName: string;
  truncated: boolean;
  expiresAt: string;
  sheets: Array<{ index: number; name: string; rowCount: number; headers: string[] }>;
};

export type FeedActivationSuggestion = {
  id: string;
  title: string;
  type: 'activation' | 'combined';
  purpose: string;
  sourceIds: string[];
  sourceNames: string[];
  sheetIndex?: number;
  mappings?: CombinedMapping[];
  config?: CombinedSourceConfig;
  definition?: Record<string, unknown>;
  reason: string;
  editable: true;
  activated: false;
  requiresReview: true;
  metadata: Array<{ sourceId: string; sheetIndex: number; headers: string[]; rowCount: number }>;
};

function clean(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value: unknown) {
  return clean(value)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function headersFor(table: SheetData) {
  // Preserve empty positions: a column index is part of the approved
  // mapping, so filtering a blank header would silently shift every column.
  return (table.rows[0] ?? [])
    .slice(0, 120)
    .map((value) => (value === null || value === undefined ? '' : String(value)));
}

function tablesFor(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!safeSheet(item)) return [];
    const headers = headersFor(item);
    return [
      {
        index,
        name: clean(item.name) || `Hoja ${index + 1}`,
        rowCount: Math.max(0, item.rows.length - 1),
        headers,
        table: item,
      },
    ];
  });
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function findColumn(headers: string[], aliases: string[]) {
  const wanted = new Set(aliases.map(normalize));
  const matches = headers.flatMap((header, column) =>
    wanted.has(normalize(header)) ? [column] : [],
  );
  return matches.length === 1 ? matches[0] : null;
}

function stableIdentityColumn(headers: string[]) {
  const options = [
    ['id', 'id registro', 'record id', 'external id', 'codigo', 'código'],
    ['email', 'correo', 'correo electronico', 'correo electrónico', 'e mail'],
    ['invoice id', 'invoice number', 'numero factura', 'número factura', 'n factura', 'factura'],
  ];
  for (const aliases of options) {
    const column = findColumn(headers, aliases);
    if (column !== null) return column;
  }
  return null;
}

function column(
  sourceId: string,
  sheetIndex: number,
  headers: string[],
  index: number,
): CombinedColumn {
  return { sourceId, sheetIndex, column: index, header: headers[index] ?? `Columna ${index + 1}` };
}

function combinedConfig(
  left: FeedSourceMetadata,
  leftSheet: FeedSourceMetadata['sheets'][number],
  right: FeedSourceMetadata,
  rightSheet: FeedSourceMetadata['sheets'][number],
  leftColumn: number,
  rightColumn: number,
): CombinedSourceConfig {
  const approvedHeaders: CombinedApprovedHeaders[] = [
    { sourceId: left.sourceId, sheetIndex: leftSheet.index, headers: leftSheet.headers },
    { sourceId: right.sourceId, sheetIndex: rightSheet.index, headers: rightSheet.headers },
  ];
  const mappings: CombinedMapping[] = [
    {
      left: column(left.sourceId, leftSheet.index, leftSheet.headers, leftColumn),
      right: column(right.sourceId, rightSheet.index, rightSheet.headers, rightColumn),
    },
  ];
  return {
    version: 1,
    sourceIds: [left.sourceId, right.sourceId],
    approvedHeaders,
    mappings,
    maxRows: 1000,
  };
}

function tableSuggestion(
  source: FeedSourceMetadata,
  sheet: FeedSourceMetadata['sheets'][number],
): FeedActivationSuggestion | null {
  const recommendation = recommendFeedUse({
    name: `${source.sourceName} · ${sheet.name}`,
    text: '',
    // Only the header row enters the classifier. Suggestions never inspect or
    // return record values.
    tables: [{ name: sheet.name, rows: [sheet.headers] }],
  }).tables[0];
  if (!recommendation || recommendation.kind === 'general' || recommendation.ambiguous) return null;
  const headers = sheet.headers;
  const sourceIds = [source.sourceId];
  const metadata = [
    { sourceId: source.sourceId, sheetIndex: sheet.index, headers, rowCount: sheet.rowCount },
  ];
  let definition: Record<string, unknown> | null = null;
  let title = '';
  let purpose = '';
  if (recommendation.kind === 'invoice') {
    const mapping = {
      invoiceNumber: findColumn(headers, [
        'factura',
        'numero factura',
        'n factura',
        'invoice',
        'invoice number',
        'documento',
      ]),
      issuer: findColumn(headers, [
        'cliente',
        'proveedor',
        'tercero',
        'contraparte',
        'empresa',
        'razon social',
        'beneficiario',
      ]),
      amount: findColumn(headers, [
        'monto',
        'valor',
        'importe',
        'total',
        'subtotal',
        'saldo',
        'precio',
        'amount',
      ]),
      currency: findColumn(headers, ['moneda', 'divisa', 'currency', 'codigo moneda']),
      issuedOn: findColumn(headers, [
        'fecha',
        'fecha emision',
        'fecha pago',
        'date',
        'payment date',
      ]),
    };
    if (Object.values(mapping).some((value) => value === null)) return null;
    definition = {
      version: 1,
      name: 'Revisar facturas repetidas',
      kind: 'invoice_duplicates',
      mapping,
      caseTitle: 'Revisar factura repetida',
      caseObjective:
        'Confirmar si hay más de una fila para la misma factura antes de compartir un asunto.',
      caseNextAction: 'Comparar las filas citadas y documentar si es un duplicado real.',
    };
    title = `Revisar facturas de ${source.sourceName}`;
    purpose = 'Detectar filas que comparten factura, emisor y moneda para revisión humana.';
  } else if (recommendation.kind === 'tasks') {
    const due = findColumn(headers, [
      'vencimiento',
      'fecha vencimiento',
      'fecha limite',
      'due date',
    ]);
    const status = findColumn(headers, ['estado', 'estatus', 'status', 'etapa', 'stage']);
    if (due === null || status === null) return null;
    const identity = stableIdentityColumn(headers);
    definition = {
      version: 1,
      name: 'Revisar tareas vencidas',
      kind: 'table_rule',
      rule: 'conditions',
      conditions: [{ column: due, operator: 'before_today' }],
      match: 'all',
      groupBy: [],
      evidenceColumns: [due, status],
      ...(identity === null ? {} : { identityColumns: [identity] }),
      caseTitle: 'Revisar tarea vencida',
      caseObjective: 'Revisar la tarea y registrar el siguiente paso con evidencia.',
      caseNextAction: 'Confirmar el estado de la tarea y actualizar su fecha o responsable.',
    };
    title = `Revisar tareas vencidas de ${source.sourceName}`;
    purpose = 'Proponer una revisión periódica de tareas cuya fecha ya pasó.';
  } else if (recommendation.kind === 'contacts') {
    const identity = stableIdentityColumn(headers);
    if (identity === null) return null;
    definition = {
      version: 1,
      name: 'Revisar contactos repetidos',
      kind: 'table_rule',
      rule: 'duplicates',
      conditions: [],
      match: 'all',
      groupBy: [identity],
      evidenceColumns: [identity],
      caseTitle: 'Revisar contactos repetidos',
      caseObjective: 'Confirmar si las filas representan a la misma persona antes de consolidar.',
      caseNextAction: 'Comparar la evidencia de las filas y decidir cuál registro conservar.',
    };
    title = `Revisar contactos repetidos de ${source.sourceName}`;
    purpose = 'Detectar coincidencias exactas de un identificador estable para revisión humana.';
  } else if (recommendation.kind === 'payments') {
    const date = findColumn(headers, ['fecha', 'fecha pago', 'date', 'payment date']);
    const status = findColumn(headers, ['estado', 'estatus', 'status', 'etapa', 'stage']);
    if (date === null || status === null) return null;
    const identity = stableIdentityColumn(headers);
    definition = {
      version: 1,
      name: 'Revisar pagos pendientes',
      kind: 'table_rule',
      rule: 'conditions',
      conditions: [{ column: status, operator: 'not_equals', value: 'pagado' }],
      match: 'all',
      groupBy: [],
      evidenceColumns: [date, status],
      ...(identity === null ? {} : { identityColumns: [identity] }),
      caseTitle: 'Revisar pago pendiente',
      caseObjective: 'Confirmar el estado del pago con la fuente antes de compartir un asunto.',
      caseNextAction: 'Revisar la referencia y dejar constancia del siguiente paso.',
    };
    title = `Revisar pagos pendientes de ${source.sourceName}`;
    purpose = 'Proponer revisión de filas cuyo estado no es “pagado”.';
  }
  if (!definition) return null;
  return {
    id: `activation:${digest({ sourceId: source.sourceId, sheet: sheet.index, kind: recommendation.kind })}`,
    title,
    type: 'activation',
    purpose,
    sourceIds,
    sourceNames: [source.sourceName],
    sheetIndex: sheet.index,
    definition,
    reason: `${recommendation.name}: encabezados observados ${recommendation.observedHeaders.join(', ')}. La propuesta se puede editar y requiere simulación antes de autorizarla.`,
    editable: true,
    activated: false,
    requiresReview: true,
    metadata,
  };
}

function combinedSuggestion(
  left: FeedSourceMetadata,
  right: FeedSourceMetadata,
): FeedActivationSuggestion | null {
  let best: {
    leftSheet: FeedSourceMetadata['sheets'][number];
    rightSheet: FeedSourceMetadata['sheets'][number];
    leftColumn: number;
    rightColumn: number;
    score: number;
  } | null = null;
  const priority = new Map([
    ['id', 4],
    ['id registro', 4],
    ['record id', 4],
    ['external id', 4],
    ['email', 3],
    ['correo', 3],
    ['correo electronico', 3],
    ['invoice id', 2],
    ['invoice number', 2],
    ['numero factura', 2],
  ]);
  for (const leftSheet of left.sheets) {
    for (const rightSheet of right.sheets) {
      for (const [leftColumn, leftHeader] of leftSheet.headers.entries()) {
        const normalizedHeader = normalize(leftHeader);
        if (!priority.has(normalizedHeader)) continue;
        if (leftSheet.headers.filter((header) => header === leftHeader).length !== 1) continue;
        // A suggestion may surface a literal header seen in both snapshots,
        // but it remains an editable candidate. Do not normalize names here:
        // `ID`, `id`, and a translated or renamed header require review.
        const rightColumns = rightSheet.headers.flatMap((header, column) =>
          header === leftHeader ? [column] : [],
        );
        if (rightColumns.length !== 1) continue;
        const rightColumn = rightColumns[0];
        if (rightColumn === undefined) continue;
        const score = priority.get(normalizedHeader) ?? 0;
        if (!best || score > best.score)
          best = { leftSheet, rightSheet, leftColumn, rightColumn, score };
      }
    }
  }
  if (!best) return null;
  const config = combinedConfig(
    left,
    best.leftSheet,
    right,
    best.rightSheet,
    best.leftColumn,
    best.rightColumn,
  );
  const key = left.sheets[best.leftSheet.index]?.headers[best.leftColumn] ?? 'clave';
  return {
    id: `combined:${digest(config)}`,
    title: `Cruzar ${left.sourceName} con ${right.sourceName}`,
    type: 'combined',
    purpose: `Revisar datos de ambas fuentes usando coincidencia exacta por “${key}”.`,
    sourceIds: [left.sourceId, right.sourceId],
    sourceNames: [left.sourceName, right.sourceName],
    mappings: config.mappings,
    config,
    reason: `Hay un encabezado literal (“${key}”) en ambas fuentes. Es un candidato editable que debes revisar antes de guardar; nunca se asume que nombres similares representan a la misma persona.`,
    editable: true,
    activated: false,
    requiresReview: true,
    metadata: [
      {
        sourceId: left.sourceId,
        sheetIndex: best.leftSheet.index,
        headers: best.leftSheet.headers,
        rowCount: best.leftSheet.rowCount,
      },
      {
        sourceId: right.sourceId,
        sheetIndex: best.rightSheet.index,
        headers: best.rightSheet.headers,
        rowCount: best.rightSheet.rowCount,
      },
    ],
  };
}

export async function readFeedSourceMetadata(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
): Promise<FeedSourceMetadata[]> {
  const sources = await db
    .from('feed_sources')
    .select('id,kind,name,latest_attachment_id,enabled,status,error,config')
    .eq('organization_id', organizationId)
    .eq('actor_id', actorId)
    .eq('enabled', true)
    .neq('kind', 'combined')
    .order('name')
    .limit(100);
  if (sources.error)
    throw new CombinedSourceError('No se pudieron leer los metadatos de Feed.', 503);
  const sourceRows = (sources.data ?? []) as unknown as MetadataSource[];
  const attachmentIds = sourceRows.flatMap((source) => source.latest_attachment_id ?? []);
  const attachments = attachmentIds.length
    ? await db
        .from('chat_attachments')
        .select('id,filename,feed_tables,feed_truncated,purge_at')
        .eq('organization_id', organizationId)
        .eq('created_by', actorId)
        .in('id', attachmentIds)
        .gt('purge_at', new Date().toISOString())
    : { data: [], error: null };
  if (attachments.error)
    throw new CombinedSourceError('No se pudieron leer los metadatos de las capturas.', 503);
  const attachmentMap = new Map(
    ((attachments.data ?? []) as unknown as MetadataAttachment[]).map((attachment) => [
      attachment.id,
      attachment,
    ]),
  );
  return sourceRows.flatMap((source) => {
    const attachment = source.latest_attachment_id
      ? attachmentMap.get(source.latest_attachment_id)
      : null;
    if (!attachment) return [];
    return [
      {
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        attachmentId: attachment.id,
        attachmentName: attachment.filename,
        truncated: attachment.feed_truncated,
        expiresAt: attachment.purge_at,
        sheets: tablesFor(attachment.feed_tables).map(({ table: _table, ...sheet }) => sheet),
      },
    ];
  });
}

export async function suggestFeedActivations(
  db: SupabaseClient,
  actorId: string,
  organizationId: string,
) {
  const sources = await readFeedSourceMetadata(db, actorId, organizationId);
  const result = suggestFromFeedMetadata(sources);
  return {
    ...result,
    sources: sources.map(({ attachmentId, attachmentName, ...source }) => ({
      ...source,
      attachmentId,
      attachmentName,
    })),
  };
}

export function suggestFromFeedMetadata(sources: FeedSourceMetadata[]) {
  const proposals: FeedActivationSuggestion[] = [];
  for (const source of sources) {
    for (const sheet of source.sheets.slice(0, 20)) {
      const proposal = tableSuggestion(source, sheet);
      if (proposal) proposals.push(proposal);
    }
  }
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      const leftSource = sources[left];
      const rightSource = sources[right];
      if (!leftSource || !rightSource) continue;
      const proposal = combinedSuggestion(leftSource, rightSource);
      if (proposal) proposals.push(proposal);
    }
  }
  return {
    version: 1,
    temporary: true,
    proposals: proposals.slice(0, 40),
    note: 'Son propuestas editables basadas en encabezados y metadatos. No activan reglas ni comparten coincidencias.',
  };
}
