import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { type ClientStatus, STATUS_LABEL } from '@/lib/clients-shape';
import { CLIENT_SOURCE_LABEL, type ClientListRow, fullNit } from '@cortex/agent-tools';
import type { TeamMember } from './types';

/**
 * LA LISTA DE CLIENTES COMO GRILLA: columnas, filas y vistas de arranque.
 *
 * Se arma en el SERVIDOR (la página y el escaparate) y viaja al navegador
 * como datos: el componente de la grilla no sabe de clientes. Por eso este
 * archivo puede leer valores de `@cortex/agent-tools`; ningún componente
 * `'use client'` lo importa.
 *
 * Una cifra que no se pudo leer viaja vacía (la grilla pinta «—») y la
 * pantalla dice arriba qué faltó: nunca un cero inventado.
 */

export const CLIENTS_VIEW_SCOPE = 'clients';

/** Los nombres de la salud, en el orden en que preocupan. */
export const HEALTH_OPTIONS: GridColumn['options'] = [
  { value: 'Cartera muy vencida', tone: 'rose' },
  { value: 'Bloqueado', tone: 'rose' },
  { value: 'Pagos atrasados', tone: 'amber' },
  { value: 'Debe y está callado', tone: 'amber' },
  { value: 'Sin movimiento', tone: 'neutral' },
  { value: 'Al día', tone: 'emerald' },
];

const STATUS_TONE_GRID: Record<ClientStatus, 'emerald' | 'amber' | 'rose' | 'primary' | 'neutral'> =
  {
    prospect: 'primary',
    active: 'emerald',
    dormant: 'amber',
    former: 'neutral',
    blocked: 'rose',
  };

export function clientColumns(team: TeamMember[], tagsInUse: string[]): GridColumn[] {
  return [
    { key: 'nombre', label: 'Nombre', type: 'text', pinned: true, primary: true, width: 220 },
    { key: 'nit', label: 'NIT', type: 'text', width: 130 },
    {
      key: 'responsable',
      label: 'Responsable',
      type: 'select',
      editable: true,
      width: 150,
      options: team.map((m) => ({ value: m.id, label: m.name })),
      description: 'Quién responde por este cliente en la empresa.',
    },
    {
      key: 'facturado_12m',
      label: 'Facturado 12 meses',
      type: 'money',
      width: 150,
      description: 'Facturas emitidas en el último año, en pesos.',
    },
    {
      key: 'saldo',
      label: 'Saldo',
      type: 'money',
      width: 130,
      description: 'Lo que debe hoy, en pesos.',
    },
    {
      key: 'vencido',
      label: 'Vencido',
      type: 'money',
      width: 130,
      description: 'De ese saldo, lo que ya pasó su fecha.',
    },
    {
      key: 'dias_pago',
      label: 'Días de pago',
      type: 'number',
      width: 110,
      description: 'Días promedio entre la factura y el pago, de las facturas ya pagadas.',
    },
    { key: 'ultimo_contacto', label: 'Último contacto', type: 'date', width: 130 },
    {
      key: 'sin_contacto',
      label: 'Días sin contacto',
      type: 'number',
      width: 120,
      description: 'Desde el último correo, reunión, WhatsApp, nota o cobro enviado.',
    },
    { key: 'proximo_vencimiento', label: 'Próximo vencimiento', type: 'date', width: 150 },
    { key: 'salud', label: 'Salud', type: 'status', width: 170, options: HEALTH_OPTIONS },
    {
      key: 'etiquetas',
      label: 'Etiquetas',
      type: 'multi_select',
      editable: true,
      width: 180,
      options: tagsInUse.map((t) => ({ value: t })),
    },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      editable: true,
      width: 130,
      options: (Object.keys(STATUS_LABEL) as ClientStatus[]).map((s) => ({
        value: s,
        label: STATUS_LABEL[s],
        tone: STATUS_TONE_GRID[s],
      })),
    },
    {
      key: 'origen',
      label: 'Origen',
      type: 'select',
      width: 170,
      options: Object.values(CLIENT_SOURCE_LABEL).map((l) => ({ value: l })),
    },
    { key: 'ciudad', label: 'Ciudad', type: 'text', width: 120 },
  ];
}

/** Una fila de la grilla por cliente. */
export function clientGridRow(row: ClientListRow): GridRow {
  return {
    id: row.id,
    href: `/clients/${row.id}`,
    values: {
      nombre: row.name,
      nit: fullNit(row.taxId),
      responsable: row.ownerId,
      facturado_12m: row.invoiced12m,
      saldo: row.outstanding,
      vencido: row.overdue,
      dias_pago: row.paymentDays,
      ultimo_contacto: row.lastContactAt ? row.lastContactAt.slice(0, 10) : null,
      sin_contacto: row.quietDays,
      proximo_vencimiento: row.nextDueOn,
      salud: row.health.label,
      etiquetas: row.tags,
      estado: row.status,
      origen: CLIENT_SOURCE_LABEL[row.source as keyof typeof CLIENT_SOURCE_LABEL] ?? row.source,
      ciudad: row.city,
    },
  };
}

/** Las etiquetas que ya existen, para ofrecerlas al etiquetar. */
export function tagsInUse(rows: readonly ClientListRow[]): string[] {
  return [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b, 'es'));
}

export interface ClientPreset {
  id: string;
  label: string;
  view: Partial<GridView>;
}

const BASE: Partial<GridView> = {
  layout: 'table',
  hidden: ['sin_contacto', 'ciudad', 'origen'],
};

/**
 * Las vistas con las que se arranca, como botones sobre la grilla. No se
 * guardan: son las preguntas de todos los días. Las vistas propias del equipo
 * van aparte, guardadas con scope `clients`.
 */
export function clientPresets(viewerId: string | null): ClientPreset[] {
  const presets: ClientPreset[] = [
    {
      id: 'todos',
      label: 'Todos',
      view: { ...BASE, filters: [], sort: [{ key: 'saldo', dir: 'desc' }] },
    },
    {
      id: 'vencida',
      label: 'Con cartera vencida',
      view: {
        ...BASE,
        filters: [{ key: 'vencido', op: 'gt', value: 0 }],
        sort: [{ key: 'vencido', dir: 'desc' }],
      },
    },
    {
      id: 'sin-contacto',
      label: 'Sin contacto en 30 días',
      view: {
        ...BASE,
        hidden: ['ciudad', 'origen'],
        match: 'any',
        filters: [
          { key: 'sin_contacto', op: 'gt', value: 30 },
          { key: 'sin_contacto', op: 'empty' },
        ],
        sort: [{ key: 'saldo', dir: 'desc' }],
      },
    },
    {
      id: 'por-cobrar',
      label: 'Con saldo',
      view: {
        ...BASE,
        filters: [{ key: 'saldo', op: 'gt', value: 0 }],
        sort: [{ key: 'proximo_vencimiento', dir: 'asc' }],
      },
    },
  ];
  if (viewerId) {
    presets.splice(1, 0, {
      id: 'mios',
      label: 'Mis clientes',
      view: {
        ...BASE,
        filters: [{ key: 'responsable', op: 'eq', value: viewerId }],
        sort: [{ key: 'saldo', dir: 'desc' }],
      },
    });
  }
  return presets;
}

/** Qué frase llevar al chat sobre la lista. */
export const CLIENTS_ASK_CONTEXT =
  'Estoy mirando la lista de clientes de la empresa, con su facturación, saldo, vencido, días de pago y último contacto.';
