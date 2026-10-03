import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import type { ExpirationDetail, Option, ReviewItem } from '@/components/doc-expirations/types';
import {
  EXPIRATION_KINDS,
  EXPIRATION_KIND_LABEL,
  EXPIRATION_STATUS_LABEL,
  EXPIRATION_SUBJECT_KINDS,
  EXPIRATION_SUBJECT_KIND_LABEL,
  type Expiration,
} from '@cortex/agent-tools';

/**
 * DOCUMENTOS QUE VENCEN COMO GRILLA: columnas, filas, vistas de arranque y el
 * detalle de cada fila.
 *
 * Se arma en el SERVIDOR (la página y el escaparate) y viaja como datos: los
 * componentes `'use client'` no importan valores de `@cortex/agent-tools` (el
 * barril arrastra módulos de Node al navegador). Una fecha que no se pudo leer
 * viaja vacía y la fila dice por qué; nunca una fecha calculada.
 */

export const EXPIRATIONS_VIEW_SCOPE = 'document_expirations';

export const KIND_OPTIONS: Option[] = EXPIRATION_KINDS.map((k) => ({
  value: k,
  label: EXPIRATION_KIND_LABEL[k],
}));

export const SUBJECT_KIND_OPTIONS: Option[] = EXPIRATION_SUBJECT_KINDS.map((k) => ({
  value: k,
  label: EXPIRATION_SUBJECT_KIND_LABEL[k],
}));

const STATUS_OPTIONS: GridColumn['options'] = [
  { value: 'vencido', label: EXPIRATION_STATUS_LABEL.vencido, tone: 'rose' },
  { value: 'por_vencer', label: EXPIRATION_STATUS_LABEL.por_vencer, tone: 'amber' },
  { value: 'vigente', label: EXPIRATION_STATUS_LABEL.vigente, tone: 'emerald' },
  { value: 'renovado', label: EXPIRATION_STATUS_LABEL.renovado, tone: 'neutral' },
];

export function expirationColumns(team: Option[]): GridColumn[] {
  return [
    { key: 'documento', label: 'Documento', type: 'text', pinned: true, primary: true, width: 230 },
    {
      key: 'tipo',
      label: 'Tipo',
      type: 'select',
      width: 130,
      options: KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    },
    {
      key: 'sujeto',
      label: 'De qué o de quién',
      type: 'text',
      width: 160,
      description: 'La placa, el cliente, la persona o la empresa.',
    },
    { key: 'vence', label: 'Vence', type: 'date', width: 120 },
    {
      key: 'dias',
      label: 'Días',
      type: 'number',
      width: 90,
      description: 'Días que faltan; negativo si ya venció.',
    },
    { key: 'estado', label: 'Estado', type: 'status', width: 120, options: STATUS_OPTIONS },
    {
      key: 'responsable',
      label: 'Responsable',
      type: 'select',
      editable: true,
      width: 150,
      options: team.map((m) => ({ value: m.value, label: m.label })),
      description: 'Quién lo renueva. A esta persona le llegan los avisos.',
    },
    {
      key: 'anticipacion',
      label: 'Avisar con',
      type: 'number',
      editable: true,
      width: 110,
      description: 'Días antes del vencimiento en que empieza el aviso.',
    },
    {
      key: 'evidencia',
      label: 'Evidencia',
      type: 'long_text',
      width: 280,
      description: 'La frase del documento que dice la fecha.',
    },
    { key: 'emisor', label: 'Expedido por', type: 'text', width: 160 },
    { key: 'numero', label: 'Número', type: 'text', width: 130 },
  ];
}

export function expirationGridRow(e: Expiration): GridRow {
  return {
    id: e.id,
    values: {
      documento: e.title,
      tipo: e.kind,
      sujeto: e.subject ?? e.clientName ?? e.vehiclePlate ?? '',
      vence: e.expiresOn,
      dias: e.daysLeft,
      estado: e.status,
      responsable: null as string | null,
      anticipacion: e.renewalLeadDays,
      evidencia:
        e.source === 'manual'
          ? 'Registrado a mano'
          : e.evidenceHidden
            ? 'En un espacio del Cerebro que no ves'
            : (e.evidence ?? 'Sin frase con la fecha'),
      emisor: e.issuer,
      numero: e.number,
    },
  };
}

/** Con el id del responsable (la grilla edita por id, muestra el nombre). */
export function expirationRows(list: Array<Expiration & { ownerId: string | null }>): GridRow[] {
  return list.map((e) => {
    const row = expirationGridRow(e);
    row.values.responsable = e.ownerId;
    return row;
  });
}

export function expirationDetail(e: Expiration, spaceId: string | null): ExpirationDetail {
  return {
    id: e.id,
    title: e.title,
    kindLabel: e.kindLabel,
    subject: e.subject,
    subjectKindLabel: e.subjectKindLabel,
    issuer: e.issuer,
    number: e.number,
    issuedOn: e.issuedOn,
    expiresOn: e.expiresOn,
    when: e.when,
    statusLabel: e.statusLabel,
    status: e.status,
    owner: e.owner,
    renewalLeadDays: e.renewalLeadDays,
    confidence: e.confidence,
    confidenceLabel: e.confidenceLabel,
    reviewNote: e.reviewNote,
    source: e.source,
    evidence: e.evidence,
    evidenceHidden: e.evidenceHidden,
    documentTitle: e.documentTitle,
    documentHref: e.documentId ? `/kb?document=${encodeURIComponent(e.documentId)}` : null,
    spaceId,
    clientHref: e.clientId ? `/clients/${e.clientId}` : null,
    clientName: e.clientName,
    vehiclePlate: e.vehiclePlate,
    commitmentHref: e.commitmentId ? `/commitments/${e.commitmentId}` : null,
  };
}

export function expirationPresets(): Array<{ id: string; label: string; view: Partial<GridView> }> {
  const open = { key: 'estado', op: 'in' as const, value: ['vencido', 'por_vencer', 'vigente'] };
  // Sumar días o anticipaciones no dice nada: el pie de esas columnas va vacío.
  const aggregates = { dias: 'none', anticipacion: 'none' } as const;
  return [
    {
      id: 'todos',
      label: 'Todo lo vigilado',
      view: {
        filters: [open],
        sort: [{ key: 'vence', dir: 'asc' }],
        layout: 'table',
        aggregates,
        hidden: ['emisor', 'numero'],
      },
    },
    {
      id: 'urgente',
      label: 'Vencidos y por vencer',
      view: {
        filters: [{ key: 'estado', op: 'in', value: ['vencido', 'por_vencer'] }],
        sort: [{ key: 'vence', dir: 'asc' }],
        layout: 'table',
        aggregates,
        hidden: ['emisor', 'numero'],
      },
    },
    {
      id: 'mes',
      label: 'Vence este mes',
      view: {
        filters: [open, { key: 'vence', op: 'next_days', value: 31 }],
        sort: [{ key: 'vence', dir: 'asc' }],
        layout: 'table',
        aggregates,
        hidden: ['emisor', 'numero'],
      },
    },
    {
      id: 'flota',
      label: 'Vehículos',
      view: {
        filters: [open, { key: 'tipo', op: 'in', value: ['soat', 'tecnomecanica'] }],
        sort: [{ key: 'vence', dir: 'asc' }],
        layout: 'table',
        aggregates,
        hidden: ['emisor'],
      },
    },
    {
      id: 'polizas',
      label: 'Pólizas y contratos',
      view: {
        filters: [open, { key: 'tipo', op: 'in', value: ['poliza', 'contrato'] }],
        sort: [{ key: 'vence', dir: 'asc' }],
        layout: 'table',
        aggregates,
      },
    },
    {
      id: 'calendario',
      label: 'Calendario',
      view: {
        filters: [open],
        sort: [],
        layout: 'calendar',
        aggregates,
        layoutKey: 'vence',
        hidden: [],
      },
    },
  ];
}

/** Una fila adaptada más lo que la pantalla necesita y el chat no. */
export type ScreenExpiration = Expiration & { ownerId: string | null; spaceId: string | null };

export interface ExpirationsScreenData {
  columns: GridColumn[];
  rows: GridRow[];
  details: Record<string, ExpirationDetail>;
  presets: ReturnType<typeof expirationPresets>;
  review: ReviewItem[];
}

/** Todo lo que pintan la lista y la cola, armado de una vez (página y escaparate). */
export function buildExpirationsScreen(
  watched: ScreenExpiration[],
  pending: ScreenExpiration[],
  team: Option[],
): ExpirationsScreenData {
  const visible = watched.filter((e) => e.status !== 'descartado');
  const details: Record<string, ExpirationDetail> = {};
  for (const e of visible) details[e.id] = expirationDetail(e, e.spaceId);
  const review: ReviewItem[] = pending
    .filter((e) => e.status !== 'descartado')
    // Lo de confianza baja primero: es lo que más necesita ojos.
    .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence])
    .map((e) => ({
      ...expirationDetail(e, e.spaceId),
      kind: e.kind,
      subjectKind: e.subjectKind,
      ownerId: e.ownerId,
    }));
  return {
    columns: expirationColumns(team),
    rows: expirationRows(visible),
    details,
    presets: expirationPresets(),
    review,
  };
}

const CONFIDENCE_ORDER = { baja: 0, media: 1, alta: 2 } as const;
