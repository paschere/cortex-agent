import type { DuplicateRule } from '../trackers/duplicates';
import type { TrackerField } from '../trackers/schema';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, type ViewSpec, viewSpecSchema } from '../views/spec';
import type { RoleInput } from './store';

/**
 * LAS PLANTILLAS DE «NUEVA APLICACIÓN».
 *
 * Una plantilla trae la tabla que necesita (se crea sólo si no existe, con
 * `defineTracker`; nunca se le cambia el esquema a una tabla con filas), sus
 * pantallas como specs de vista y sus roles con permisos. Todo pasa por el
 * mismo contrato que una app armada a mano: `validateSpec` para cada
 * pantalla y `appPermissionsSchema` para cada rol. `templates.test.ts` lo
 * comprueba contra el catálogo de verdad, para que renombrar un campo rompa la
 * prueba y no la plantilla.
 *
 * La primera es el caso real que motivó las apps: el control de guías en
 * planta. Operario registra (con foto, dictado y sin señal) y ve lo suyo;
 * supervisor aprueba, rechaza y revisa duplicados; gerencia mira el tablero y
 * exporta.
 */

export interface AppTemplateScreen {
  slug: string;
  title: string;
  icon: string;
  /** Claves de los roles que la ven; vacío = todos. */
  roles: string[];
  spec: ViewSpec;
}

export interface AppTemplateTracker {
  slug: string;
  name: string;
  description: string;
  fields: TrackerField[];
  duplicates?: DuplicateRule;
}

export interface AppTemplate {
  id: string;
  name: string;
  icon: string;
  body: string;
  accent: 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';
  trackers: AppTemplateTracker[];
  roles: RoleInput[];
  screens: AppTemplateScreen[];
  homeScreen: string;
}

const GUIAS = 'guias';

const guiasFields: TrackerField[] = [
  {
    key: 'numero_guia',
    label: 'Número de guía',
    type: 'text',
    required: true,
    placeholder: '123-45678901',
  },
  { key: 'fecha', label: 'Fecha', type: 'date', required: true, default: 'today', max: 'today' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    options: ['Pendiente', 'Aprobada', 'Rechazada', 'Duplicada'],
  },
  { key: 'ubicacion', label: 'Ubicación', type: 'text', required: false, placeholder: 'Muelle 3' },
  { key: 'foto', label: 'Foto', type: 'file', required: false, accept: 'image' },
  { key: 'observaciones', label: 'Observaciones', type: 'longtext', required: false },
  { key: 'motivo_rechazo', label: 'Motivo del rechazo', type: 'text', required: false },
  {
    key: 'registrado_por',
    label: 'Registrado por',
    type: 'text',
    required: false,
    default: 'viewer',
  },
] as TrackerField[];

const OPERATOR_THEME = { layout: 'operator', density: 'comfortable' } as const;

const registrar: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'emerald',
  refreshSeconds: 0,
  editing: 'team',
  alerts: [],
  theme: { ...OPERATOR_THEME, accent: 'emerald' },
  blocks: [
    {
      id: 'registrar',
      type: 'form',
      width: 'full',
      tracker: GUIAS,
      title: 'Registrar guía',
      intro:
        'Escanea o dicta el número, toma la foto y envía. Sin señal se guarda y se envía después.',
      fields: ['numero_guia', 'fecha', 'ubicacion', 'foto', 'observaciones'],
      submitLabel: 'Registrar',
      successMessage: 'Guía registrada. Queda pendiente de aprobación.',
      editWindowMinutes: 15,
      approval: {
        field: 'estado',
        pending: 'Pendiente',
        approved: 'Aprobada',
        rejected: 'Rechazada',
        notesField: 'motivo_rechazo',
      },
    },
  ],
});

const misRegistros: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'emerald',
  refreshSeconds: 30,
  editing: 'off',
  alerts: [],
  theme: { ...OPERATOR_THEME, accent: 'emerald' },
  blocks: [
    {
      id: 'hoy',
      type: 'metric',
      width: 'half',
      tracker: GUIAS,
      title: 'Registradas hoy y ayer',
      aggregate: 'count',
      filters: [{ field: 'fecha', op: 'last_days', value: 1 }],
      tone: 'emerald',
    },
    {
      id: 'rechazadas',
      type: 'metric',
      width: 'half',
      tracker: GUIAS,
      title: 'Rechazadas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Rechazada' }],
      tone: 'rose',
    },
    {
      id: 'lista',
      type: 'table',
      width: 'full',
      tracker: GUIAS,
      title: 'Mis registros',
      columns: ['numero_guia', 'fecha', 'estado', 'ubicacion', 'motivo_rechazo'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 100,
    },
    {
      id: 'detalle',
      type: 'detail',
      width: 'full',
      tracker: GUIAS,
      titleField: 'numero_guia',
      subtitleField: 'ubicacion',
      statusField: 'estado',
      sections: [
        { title: 'Guía', fields: ['fecha', 'ubicacion', 'registrado_por'] },
        { title: 'Observaciones', fields: ['observaciones', 'motivo_rechazo'] },
      ],
      gallery: ['foto'],
      timeline: { show: ['created', 'changes', 'approvals', 'files'], limit: 30 },
    },
  ],
});

const porAprobar: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'amber',
  refreshSeconds: 10,
  editing: 'team',
  alerts: [
    {
      id: 'nuevas',
      source: GUIAS,
      filters: [{ field: 'estado', op: 'eq', value: 'Pendiente' }],
      on: 'new',
      message: 'Guía nueva por aprobar',
      sound: true,
      desktop: true,
      bell: false,
    },
  ],
  theme: { accent: 'amber', density: 'compact' },
  blocks: [
    {
      id: 'pendientes',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Por aprobar',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Pendiente' }],
      tone: 'amber',
    },
    {
      id: 'aprobadas_hoy',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Aprobadas hoy y ayer',
      aggregate: 'count',
      filters: [
        { field: 'estado', op: 'eq', value: 'Aprobada' },
        { field: 'fecha', op: 'last_days', value: 1 },
      ],
      tone: 'emerald',
    },
    {
      id: 'duplicadas',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Duplicadas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Duplicada' }],
      tone: 'rose',
    },
    {
      id: 'cola',
      type: 'table',
      width: 'full',
      tracker: GUIAS,
      title: 'Pendientes de aprobación',
      columns: ['numero_guia', 'fecha', 'ubicacion', 'registrado_por', 'foto'],
      filters: [{ field: 'estado', op: 'eq', value: 'Pendiente' }],
      sort: { field: 'created_at', dir: 'asc' },
      limit: 100,
    },
    {
      id: 'dup',
      type: 'table',
      width: 'full',
      tracker: GUIAS,
      title: 'Duplicados por resolver',
      columns: ['numero_guia', 'fecha', 'ubicacion', 'registrado_por', 'observaciones'],
      filters: [{ field: 'estado', op: 'eq', value: 'Duplicada' }],
      editable: ['numero_guia', 'fecha', 'estado'],
      sort: { field: 'numero_guia', dir: 'asc' },
      limit: 100,
    },
    {
      id: 'detalle',
      type: 'detail',
      width: 'full',
      tracker: GUIAS,
      titleField: 'numero_guia',
      subtitleField: 'ubicacion',
      statusField: 'estado',
      sections: [
        { title: 'Guía', fields: ['fecha', 'ubicacion', 'registrado_por'] },
        { title: 'Observaciones', fields: ['observaciones', 'motivo_rechazo'] },
      ],
      gallery: ['foto'],
      timeline: { limit: 30 },
    },
    // El formulario con aprobación es lo que enciende Aprobar / Rechazar en
    // las tablas de arriba (`approvalFor` busca en ESTA pantalla). Al final,
    // para que el supervisor también pueda registrar si hace falta.
    {
      id: 'registrar_sup',
      type: 'form',
      width: 'full',
      tracker: GUIAS,
      title: 'Registrar una guía',
      fields: ['numero_guia', 'fecha', 'ubicacion', 'foto', 'observaciones'],
      submitLabel: 'Registrar',
      successMessage: 'Guía registrada.',
      approval: {
        field: 'estado',
        pending: 'Pendiente',
        approved: 'Aprobada',
        rejected: 'Rechazada',
        notesField: 'motivo_rechazo',
      },
    },
  ],
});

const tablero: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'primary',
  refreshSeconds: 60,
  editing: 'off',
  alerts: [],
  theme: { accent: 'primary', header: 'hero' },
  filtersBar: [
    { id: 'f_fecha', label: 'Fechas', kind: 'date_range', source: GUIAS, field: 'fecha' },
  ],
  blocks: [
    {
      id: 'total',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Guías registradas',
      aggregate: 'count',
      compare: 'previous_period',
      period: 'week',
      dateField: 'fecha',
    },
    {
      id: 'aprobadas',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Aprobadas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Aprobada' }],
      tone: 'emerald',
    },
    {
      id: 'rechazo',
      type: 'metric',
      width: 'third',
      tracker: GUIAS,
      title: 'Rechazadas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Rechazada' }],
      tone: 'rose',
      goodWhen: 'down',
    },
    {
      id: 'por_dia',
      type: 'chart',
      width: 'half',
      tracker: GUIAS,
      title: 'Guías por día',
      chart: 'bar',
      groupBy: 'fecha',
      bucket: 'day',
      aggregate: 'count',
    },
    {
      id: 'embudo',
      type: 'chart',
      width: 'half',
      tracker: GUIAS,
      title: 'Por estado',
      chart: 'funnel',
      groupBy: 'estado',
      aggregate: 'count',
    },
    {
      id: 'todas',
      type: 'table',
      width: 'full',
      tracker: GUIAS,
      title: 'Todas las guías',
      columns: ['numero_guia', 'fecha', 'estado', 'ubicacion', 'registrado_por'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 200,
    },
  ],
});

export const CONTROL_EN_PLANTA: AppTemplate = {
  id: 'control_planta',
  name: 'Control en planta',
  icon: '🏭',
  body: 'Los operarios registran guías con foto y sin señal; el supervisor aprueba y resuelve duplicados; gerencia ve el tablero y exporta.',
  accent: 'emerald',
  trackers: [
    {
      slug: GUIAS,
      name: 'Guías',
      description: 'Cada guía que entra a la planta: número, fecha, estado y foto.',
      fields: guiasFields,
      duplicates: {
        key: 'numero_guia',
        distinctBy: 'fecha',
        flagField: 'estado',
        flagValue: 'Duplicada',
      },
    },
  ],
  roles: [
    {
      key: 'operario',
      name: 'Operario',
      description: 'Registra guías y ve sólo las suyas.',
      permissions: {
        tables: {
          [GUIAS]: {
            read: 'own',
            create: true,
            edit: 'own',
            fields: ['numero_guia', 'fecha', 'ubicacion', 'foto', 'observaciones'],
            actions: [],
          },
        },
        export: false,
      },
    },
    {
      key: 'supervisor',
      name: 'Supervisor',
      description: 'Ve todo, aprueba o rechaza y corrige duplicados.',
      permissions: {
        tables: {
          [GUIAS]: {
            read: 'all',
            create: true,
            edit: 'all',
            actions: [APPROVE_ACTION_ID, REJECT_ACTION_ID],
          },
        },
        export: true,
      },
    },
    {
      key: 'gerencia',
      name: 'Gerencia',
      description: 'Mira el tablero y exporta; no escribe.',
      permissions: {
        tables: { [GUIAS]: { read: 'all', create: false, edit: 'none', actions: [] } },
        export: true,
      },
    },
  ],
  screens: [
    {
      slug: 'registrar',
      title: 'Registrar',
      icon: 'ClipboardPlus',
      roles: ['operario', 'supervisor'],
      spec: registrar,
    },
    {
      slug: 'mis_registros',
      title: 'Mis registros',
      icon: 'ListChecks',
      roles: ['operario'],
      spec: misRegistros,
    },
    {
      slug: 'por_aprobar',
      title: 'Por aprobar',
      icon: 'BadgeCheck',
      roles: ['supervisor'],
      spec: porAprobar,
    },
    {
      slug: 'tablero',
      title: 'Tablero',
      icon: 'BarChart3',
      roles: ['supervisor', 'gerencia'],
      spec: tablero,
    },
  ],
  homeScreen: 'registrar',
};

// ---------------------------------------------------------------------------
// Portal de clientes (fase 4)
// ---------------------------------------------------------------------------
//
// Lo que un cliente de la empresa abre en su celular: SUS pedidos o guías con
// el estado, una solicitud nueva y SUS documentos. Es el caso de más riesgo de
// las apps (una fuga entre clientes), así que todo cuelga de UN dato: el rol
// «Cliente» lee `{field: 'cliente', equals: '$user.cliente'}` y el servidor
// aplica ese filtro ANTES de calcular tablas, cifras y Excel. Al invitar a
// alguien a ese rol se le pide su cliente (con los valores reales de la
// columna) y al crear una solicitud el servidor escribe el cliente por él: no
// puede pedir ni crear a nombre de otro.

const PEDIDOS = 'pedidos_cliente';
const DOCUMENTOS = 'documentos_cliente';
const CLIENTE_ATTR = '$user.cliente';

// La primera columna es la etiqueta de cada fila: el número del pedido, no el cliente.
const pedidosFields: TrackerField[] = [
  {
    key: 'referencia',
    label: 'Pedido o guía',
    type: 'text',
    required: true,
    placeholder: 'Número de pedido o guía',
  },
  { key: 'cliente', label: 'Cliente', type: 'text', required: true },
  { key: 'fecha', label: 'Fecha', type: 'date', required: true, default: 'today', max: 'today' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    options: ['Solicitada', 'En proceso', 'Despachada', 'Entregada', 'Cancelada'],
    default: 'Solicitada',
  },
  { key: 'descripcion', label: 'Detalle', type: 'longtext', required: false },
  { key: 'respuesta', label: 'Respuesta de la empresa', type: 'longtext', required: false },
] as TrackerField[];

const documentosFields: TrackerField[] = [
  { key: 'nombre', label: 'Nombre del documento', type: 'text', required: true },
  { key: 'cliente', label: 'Cliente', type: 'text', required: true },
  {
    key: 'tipo',
    label: 'Tipo',
    type: 'select',
    required: false,
    options: ['Factura', 'Remisión', 'Certificado', 'Contrato', 'Otro'],
  },
  { key: 'fecha', label: 'Fecha', type: 'date', required: false, default: 'today', max: 'today' },
  { key: 'archivo', label: 'Archivo', type: 'file', required: true },
] as TrackerField[];

const misPedidos: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 60,
  editing: 'off',
  alerts: [],
  theme: { accent: 'sky', layout: 'operator', density: 'comfortable' },
  blocks: [
    {
      id: 'en_curso',
      type: 'metric',
      width: 'half',
      tracker: PEDIDOS,
      title: 'En curso',
      aggregate: 'count',
      filters: [
        { field: 'estado', op: 'neq', value: 'Entregada' },
        { field: 'estado', op: 'neq', value: 'Cancelada' },
      ],
      tone: 'amber',
    },
    {
      id: 'entregados',
      type: 'metric',
      width: 'half',
      tracker: PEDIDOS,
      title: 'Entregados',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Entregada' }],
      tone: 'emerald',
    },
    {
      id: 'tarjetas',
      type: 'gallery',
      width: 'full',
      tracker: PEDIDOS,
      title: 'Mis pedidos y guías',
      titleField: 'referencia',
      subtitleField: 'fecha',
      badgeField: 'estado',
      metaFields: ['descripcion', 'respuesta'],
      columns: 2,
      sort: { field: 'created_at', dir: 'desc' },
      limit: 24,
    },
  ],
});

const nuevaSolicitud: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 0,
  editing: 'team',
  alerts: [],
  theme: { accent: 'sky', layout: 'operator', density: 'comfortable' },
  blocks: [
    {
      id: 'solicitud',
      type: 'form',
      width: 'full',
      tracker: PEDIDOS,
      title: 'Nueva solicitud',
      intro: 'Cuéntanos qué necesitas. Te respondemos aquí mismo, en «Mis pedidos».',
      fields: ['referencia', 'fecha', 'descripcion'],
      submitLabel: 'Enviar solicitud',
      successMessage: 'Solicitud enviada. La verás en «Mis pedidos».',
    },
  ],
});

const misDocumentos: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 60,
  editing: 'team',
  alerts: [],
  theme: { accent: 'sky', layout: 'operator', density: 'comfortable' },
  blocks: [
    {
      id: 'lista_docs',
      type: 'table',
      width: 'full',
      tracker: DOCUMENTOS,
      title: 'Mis documentos',
      columns: ['nombre', 'tipo', 'fecha', 'archivo'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 100,
    },
    {
      id: 'subir_doc',
      type: 'form',
      width: 'full',
      tracker: DOCUMENTOS,
      title: 'Subir un documento',
      fields: ['nombre', 'tipo', 'fecha', 'archivo'],
      submitLabel: 'Subir',
      successMessage: 'Documento guardado.',
    },
  ],
});

const atencion: ViewSpec = viewSpecSchema.parse({
  version: 1,
  accent: 'primary',
  refreshSeconds: 30,
  editing: 'team',
  alerts: [
    {
      id: 'nuevas',
      source: PEDIDOS,
      filters: [{ field: 'estado', op: 'eq', value: 'Solicitada' }],
      on: 'new',
      message: 'Solicitud nueva de un cliente',
      sound: true,
      desktop: true,
      bell: false,
    },
  ],
  theme: { accent: 'primary', density: 'compact' },
  blocks: [
    {
      id: 'por_atender',
      type: 'metric',
      width: 'third',
      tracker: PEDIDOS,
      title: 'Por atender',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Solicitada' }],
      tone: 'amber',
    },
    {
      id: 'en_proceso',
      type: 'metric',
      width: 'third',
      tracker: PEDIDOS,
      title: 'En proceso',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'En proceso' }],
    },
    {
      id: 'por_estado',
      type: 'chart',
      width: 'third',
      tracker: PEDIDOS,
      title: 'Por estado',
      chart: 'funnel',
      groupBy: 'estado',
      aggregate: 'count',
    },
    {
      id: 'todos',
      type: 'table',
      width: 'full',
      tracker: PEDIDOS,
      title: 'Pedidos y solicitudes de todos los clientes',
      columns: ['cliente', 'referencia', 'fecha', 'estado', 'descripcion', 'respuesta'],
      editable: ['estado', 'respuesta'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 200,
    },
  ],
});

export const PORTAL_CLIENTES: AppTemplate = {
  id: 'portal_clientes',
  name: 'Portal de clientes',
  icon: '🤝',
  body: 'Tus clientes ven sólo SUS pedidos y guías con el estado, hacen una solicitud nueva y descargan sus documentos; tu equipo atiende todo desde un tablero.',
  accent: 'sky',
  trackers: [
    {
      slug: PEDIDOS,
      name: 'Pedidos de clientes',
      description: 'Pedidos, guías y solicitudes de cada cliente, con su estado.',
      fields: pedidosFields,
    },
    {
      slug: DOCUMENTOS,
      name: 'Documentos de clientes',
      description: 'Facturas, remisiones y certificados de cada cliente.',
      fields: documentosFields,
    },
  ],
  roles: [
    {
      key: 'cliente',
      name: 'Cliente',
      description: 'Ve sólo lo de su empresa: sus pedidos, su estado y sus documentos.',
      permissions: {
        tables: {
          [PEDIDOS]: {
            read: { field: 'cliente', equals: CLIENTE_ATTR },
            create: true,
            edit: 'none',
            fields: ['referencia', 'fecha', 'descripcion'],
            actions: [],
          },
          [DOCUMENTOS]: {
            read: { field: 'cliente', equals: CLIENTE_ATTR },
            create: true,
            edit: 'none',
            fields: ['nombre', 'tipo', 'fecha', 'archivo'],
            actions: [],
          },
        },
        export: false,
      },
    },
    {
      key: 'atencion',
      name: 'Atención al cliente',
      description: 'Ve y atiende a todos los clientes: cambia el estado y responde.',
      permissions: {
        tables: {
          [PEDIDOS]: { read: 'all', create: true, edit: 'all', actions: [] },
          [DOCUMENTOS]: { read: 'all', create: true, edit: 'all', actions: [] },
        },
        export: true,
      },
    },
  ],
  screens: [
    {
      slug: 'mis_pedidos',
      title: 'Mis pedidos',
      icon: 'Package',
      roles: ['cliente'],
      spec: misPedidos,
    },
    {
      slug: 'nueva_solicitud',
      title: 'Nueva solicitud',
      icon: 'ClipboardPlus',
      roles: ['cliente'],
      spec: nuevaSolicitud,
    },
    {
      slug: 'mis_documentos',
      title: 'Mis documentos',
      icon: 'Table2',
      roles: ['cliente'],
      spec: misDocumentos,
    },
    {
      slug: 'atencion',
      title: 'Atención',
      icon: 'BarChart3',
      roles: ['atencion'],
      spec: atencion,
    },
  ],
  homeScreen: 'mis_pedidos',
};

export const APP_TEMPLATES: readonly AppTemplate[] = [CONTROL_EN_PLANTA, PORTAL_CLIENTES];

export function appTemplate(id: string): AppTemplate | null {
  return APP_TEMPLATES.find((t) => t.id === id) ?? null;
}
