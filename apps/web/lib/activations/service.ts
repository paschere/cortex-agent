import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { SheetData, SheetValue } from '@cortex/agent-tools/src/kb/spreadsheets';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActivationCandidate,
  ActivationDefinition,
  ActivationRun,
  ActivationSource,
  InvoiceColumnMapping,
} from './types';

export const ACTIVATION_LIMITS = { maxSheets: 20, maxRows: 1000, maxTextLength: 240 } as const;

type FeedRow = {
  id: string;
  filename: string;
  created_at: string;
  purge_at: string;
  feed_content_hash: string | null;
  feed_tables: SheetData[] | null;
};

type StoredRun = {
  id: string;
  source_id: string;
  source_name: string;
  sheet_index: number;
  sheet_name: string;
  definition: ActivationDefinition;
  mapping: InvoiceColumnMapping | null;
  candidates: ActivationCandidate[];
  status: 'simulated' | 'committed';
  created_at: string;
  committed_at: string | null;
  case_ids: string[] | null;
};

export class ActivationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawText = (value: SheetValue | undefined) => String(value ?? '').trim();
const clean = (value: SheetValue | undefined) =>
  rawText(value).slice(0, ACTIVATION_LIMITS.maxTextLength);
const identityPart = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('es');

export function sourceSnapshot(row: FeedRow): string {
  return digest({ content: row.feed_content_hash, tables: row.feed_tables });
}

export function mapRun(row: StoredRun): ActivationRun {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sheetIndex: row.sheet_index,
    sheetName: row.sheet_name,
    definition: row.definition,
    mapping: row.mapping,
    status: row.status,
    candidates: row.candidates,
    createdAt: row.created_at,
    committedAt: row.committed_at,
    caseIds: row.case_ids ?? [],
  };
}

export function activationSource(row: FeedRow): ActivationSource {
  return {
    id: row.id,
    filename: row.filename,
    createdAt: row.created_at,
    expiresAt: row.purge_at,
    sheets: (row.feed_tables ?? []).slice(0, ACTIVATION_LIMITS.maxSheets).map((sheet, index) => ({
      index,
      name: sheet.name,
      rowCount: Math.max(0, sheet.rows.length - 1),
      headers: (sheet.rows[0] ?? []).map(clean),
    })),
  };
}

export function simulateInvoices(
  sourceIdentity: string,
  sheet: SheetData,
  mapping: InvoiceColumnMapping,
): ActivationCandidate[] {
  const body = sheet.rows.slice(1, ACTIVATION_LIMITS.maxRows + 1);
  const headers = (sheet.rows[0] ?? []).map(
    (value, column) => clean(value) || `Columna ${column + 1}`,
  );
  const candidates = body.map((row, offset): ActivationCandidate => {
    const rawInvoiceNumber = rawText(row[mapping.invoiceNumber]);
    const rawIssuer = rawText(row[mapping.issuer]);
    const invoiceNumber = rawInvoiceNumber.slice(0, ACTIVATION_LIMITS.maxTextLength);
    const issuer = rawIssuer.slice(0, ACTIVATION_LIMITS.maxTextLength);
    const amount = clean(row[mapping.amount]);
    const currency = clean(row[mapping.currency]).toUpperCase();
    const issuedOn = clean(row[mapping.issuedOn]);
    const conflicts: string[] = [];
    if (rawInvoiceNumber.length > ACTIVATION_LIMITS.maxTextLength)
      conflicts.push('El número de factura es demasiado largo.');
    if (rawIssuer.length > ACTIVATION_LIMITS.maxTextLength)
      conflicts.push('El emisor es demasiado largo.');
    if (!invoiceNumber) conflicts.push('Falta el número de factura.');
    if (!issuer) conflicts.push('Falta el emisor.');
    if (!amount || !/^\d+(?:[.,]\d{1,2})?$/.test(amount))
      conflicts.push('El monto no es un número decimal inequívoco.');
    if (!/^[A-Z]{3}$/.test(currency))
      conflicts.push('La moneda debe venir explícita con código de 3 letras.');
    const parsedDate = new Date(`${issuedOn}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== issuedOn
    )
      conflicts.push('La fecha debe venir como AAAA-MM-DD.');
    const identity = [identityPart(rawIssuer), identityPart(rawInvoiceNumber), currency];
    return {
      rowIndex: offset + 1,
      invoiceNumber,
      issuer,
      amount,
      currency,
      issuedOn,
      sourceKey: `activation:invoice:${digest(sourceIdentity).slice(0, 24)}:${digest(identity).slice(0, 32)}`,
      status: conflicts.length ? 'invalid' : 'unmatched',
      values: [...new Set(Object.values(mapping))].map((column) => ({
        column,
        header: headers[column] ?? `Columna ${column + 1}`,
        value: clean(row[column]),
      })),
      reasons: conflicts,
      groupKey: conflicts.length ? null : digest(identity).slice(0, 32),
    };
  });
  const counts = new Map<string, number>();
  for (const item of candidates) {
    if (item.status === 'unmatched')
      counts.set(item.sourceKey, (counts.get(item.sourceKey) ?? 0) + 1);
  }
  return candidates.map((item) => {
    if (item.status !== 'unmatched' || (counts.get(item.sourceKey) ?? 0) <= 1) return item;
    const peers = candidates.filter(
      (other) => other !== item && other.sourceKey === item.sourceKey,
    );
    const differingEvidence = peers.some(
      (other) => other.amount !== item.amount || other.issuedOn !== item.issuedOn,
    );
    return {
      ...item,
      status: 'matched',
      reasons: [
        differingEvidence
          ? 'Posible conflicto: coincide emisor, número y moneda, pero cambia el monto o la fecha.'
          : 'Posible duplicado: coincide emisor, número de factura y moneda con otra fila.',
      ],
    };
  });
}

function conditionMatch(raw: string, operator: string, expected = ''): boolean | null {
  const value = raw.trim();
  if (operator === 'is_empty') return value === '';
  if (operator === 'equals') return identityPart(value) === identityPart(expected);
  if (operator === 'not_equals') return identityPart(value) !== identityPart(expected);
  if (operator === 'contains') return identityPart(value).includes(identityPart(expected));
  if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
    if (
      value.length > 30 ||
      expected.length > 30 ||
      !/^-?\d+(?:\.\d+)?$/.test(value) ||
      !/^-?\d+(?:\.\d+)?$/.test(expected)
    )
      return null;
    const decimal = (input: string) => {
      const negative = input.startsWith('-');
      const unsigned = negative ? input.slice(1) : input;
      const [integer = '0', fraction = ''] = unsigned.split('.');
      return { negative, integer: integer.replace(/^0+(?=\d)/, ''), fraction };
    };
    const left = decimal(value);
    const right = decimal(expected);
    const scale = Math.max(left.fraction.length, right.fraction.length);
    const scaled = (item: ReturnType<typeof decimal>) => {
      const absolute = BigInt(`${item.integer}${item.fraction.padEnd(scale, '0')}` || '0');
      return item.negative ? -absolute : absolute;
    };
    const a = scaled(left);
    const b = scaled(right);
    return operator === 'gt'
      ? a > b
      : operator === 'gte'
        ? a >= b
        : operator === 'lt'
          ? a < b
          : a <= b;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return operator === 'before_today' ? value < today : value > today;
}

export function simulateDefinition(
  sourceIdentity: string,
  sheet: SheetData,
  definition: ActivationDefinition,
): ActivationCandidate[] {
  if (definition.kind === 'invoice_duplicates')
    return simulateInvoices(sourceIdentity, sheet, definition.mapping);
  const headers = (sheet.rows[0] ?? []).map(
    (value, column) => clean(value) || `Columna ${column + 1}`,
  );
  const referenced = [
    ...new Set([
      ...definition.conditions.map((c) => c.column),
      ...definition.groupBy,
      ...(definition.evidenceColumns ?? []),
    ]),
  ];
  const base = sheet.rows
    .slice(1, ACTIVATION_LIMITS.maxRows + 1)
    .map((row, offset): ActivationCandidate => {
      const values = referenced.map((column) => ({
        column,
        header: headers[column] ?? `Columna ${column + 1}`,
        value: clean(row[column]),
      }));
      const tooLong = referenced.filter(
        (column) => rawText(row[column]).length > ACTIVATION_LIMITS.maxTextLength,
      );
      const checks = definition.conditions.map((condition) =>
        conditionMatch(rawText(row[condition.column]), condition.operator, condition.value),
      );
      const invalid = tooLong.length > 0 || checks.some((result) => result === null);
      const conditionMatched =
        checks.length === 0
          ? true
          : definition.match === 'all'
            ? checks.every(Boolean)
            : checks.some(Boolean);
      const groupParts = definition.groupBy.map((column) => identityPart(rawText(row[column])));
      const emptyGroup = definition.rule === 'duplicates' && groupParts.some((value) => !value);
      const groupIdentity = digest(groupParts);
      const rowIdentity = digest({ row: offset + 1, values });
      const identity = definition.rule === 'duplicates' ? groupIdentity : rowIdentity;
      return {
        rowIndex: offset + 1,
        sourceKey: `activation:table:${digest(sourceIdentity).slice(0, 24)}:${digest({ definition, identity }).slice(0, 32)}`,
        status: invalid || emptyGroup ? 'invalid' : 'unmatched',
        values,
        reasons: invalid
          ? ['Una columna usada no tiene un valor válido para la regla.']
          : emptyGroup
            ? ['Falta un valor requerido para agrupar duplicados.']
            : conditionMatched
              ? []
              : ['La fila no cumple las condiciones.'],
        groupKey:
          definition.rule === 'duplicates' && !invalid && !emptyGroup && conditionMatched
            ? groupIdentity.slice(0, 32)
            : null,
      };
    });
  if (definition.rule === 'conditions')
    return base.map((candidate) =>
      candidate.status === 'unmatched' && candidate.reasons.length === 0
        ? { ...candidate, status: 'matched', reasons: ['La fila cumple la regla.'] }
        : candidate,
    );
  const counts = new Map<string, number>();
  for (const candidate of base)
    if (candidate.status !== 'invalid' && candidate.groupKey)
      counts.set(candidate.groupKey, (counts.get(candidate.groupKey) ?? 0) + 1);
  return base.map((candidate) =>
    candidate.status !== 'invalid' &&
    candidate.groupKey &&
    (counts.get(candidate.groupKey) ?? 0) >= 2
      ? {
          ...candidate,
          status: 'matched',
          reasons: ['Coincide en las columnas de agrupación con otra fila.'],
        }
      : candidate,
  );
}

export function validateMappingForSheet(sheet: SheetData, mapping: InvoiceColumnMapping) {
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  if (Object.values(mapping).some((index) => index >= width))
    throw new ActivationError('El mapeo apunta a una columna que no existe en la hoja.', 422);
}

export async function readOwnedTableSources(db: SupabaseClient, actorId: string) {
  const { data, error } = await db
    .from('chat_attachments')
    .select('id,filename,created_at,purge_at,feed_content_hash,feed_tables')
    .eq('created_by', actorId)
    .not('feed_kind', 'is', null)
    .not('feed_tables', 'is', null)
    .gt('purge_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new ActivationError('No se pudieron cargar las fuentes de Feed.', 503);
  return (data ?? []) as FeedRow[];
}

export async function createSimulation(
  db: SupabaseClient,
  actorId: string,
  source: FeedRow,
  sheetIndex: number,
  definition: ActivationDefinition,
) {
  const tables = source.feed_tables ?? [];
  if (tables.length > ACTIVATION_LIMITS.maxSheets)
    throw new ActivationError(`La fuente supera ${ACTIVATION_LIMITS.maxSheets} hojas.`, 422);
  const sheet = tables[sheetIndex];
  if (!sheet) throw new ActivationError('La hoja elegida ya no existe.', 404);
  if (sheet.rows.length - 1 > ACTIVATION_LIMITS.maxRows)
    throw new ActivationError(
      `La hoja supera ${ACTIVATION_LIMITS.maxRows} filas. Divídela antes de activar.`,
      422,
    );
  const columns =
    definition.kind === 'invoice_duplicates'
      ? Object.values(definition.mapping)
      : [
          ...definition.conditions.map((condition) => condition.column),
          ...definition.groupBy,
          ...(definition.evidenceColumns ?? []),
        ];
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  if (columns.some((column) => column >= width))
    throw new ActivationError('La regla apunta a una columna que no existe en la hoja.', 422);
  const headers = (sheet.rows[0] ?? []).map((value) => clean(value));
  const templates =
    definition.kind === 'invoice_duplicates'
      ? [definition.caseTitle, definition.caseObjective, definition.caseNextAction]
      : [definition.caseTitle, definition.caseObjective, definition.caseNextAction];
  for (const template of templates) {
    for (const match of template?.matchAll(/\{\{([^{}]+)\}\}/g) ?? []) {
      if (!headers.includes(match[1] ?? ''))
        throw new ActivationError(`La plantilla usa una columna inexistente: ${match[1]}.`, 422);
    }
  }
  const candidates = simulateDefinition(
    source.feed_content_hash ?? sourceSnapshot(source),
    sheet,
    definition,
  );
  const id = randomUUID();
  const { data, error } = await db
    .from('activation_runs')
    .insert({
      id,
      actor_id: actorId,
      source_id: source.id,
      source_name: source.filename,
      source_snapshot: sourceSnapshot(source),
      source_snapshot_data: { contentHash: source.feed_content_hash, tables: source.feed_tables },
      sheet_index: sheetIndex,
      sheet_name: sheet.name.slice(0, 240),
      definition,
      mapping: definition.kind === 'invoice_duplicates' ? definition.mapping : null,
      mapping_snapshot: digest(definition),
      candidates,
    })
    .select(
      'id,source_id,source_name,sheet_index,sheet_name,definition,mapping,candidates,status,created_at,committed_at,case_ids',
    )
    .single();
  if (error || !data) throw new ActivationError('No se pudo guardar la simulación.', 503);
  return mapRun(data as StoredRun);
}

export type { FeedRow, StoredRun };
