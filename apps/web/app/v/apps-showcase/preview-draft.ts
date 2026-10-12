import { type AppPreview, appDraftSchema, buildAppPreview } from '@cortex/agent-tools';

/**
 * Un borrador de ejemplo para /v/apps-showcase?preview=1: una app de envíos con
 * un flujo por estados. Sólo para mirar el diseño (la vista previa real la
 * calcula el servidor con la sesión, lib/apps/preview-actions.ts).
 */

const STATES = ['Recibido', 'En bodega', 'Despachado', 'Entregado'];

export const SAMPLE_DRAFT = appDraftSchema.parse({
  name: 'Control de envíos',
  description: 'Del recibido a la entrega, con foto de prueba.',
  icon: '📦',
  tables: [
    {
      slug: 'envios',
      name: 'Envíos',
      description: 'Cada paquete y por dónde va.',
      fields: [
        { key: 'guia', label: 'Guía', type: 'text', required: true },
        { key: 'cliente', label: 'Cliente', type: 'text', required: true },
        { key: 'valor', label: 'Valor declarado', type: 'money', required: false },
        {
          key: 'estado',
          label: 'Estado',
          type: 'select',
          required: false,
          options: STATES,
          flow: {
            states: STATES,
            transitions: [
              { from: 'Recibido', to: 'En bodega' },
              { from: 'En bodega', to: 'Despachado', roles: ['supervisor'] },
              { from: 'Despachado', to: 'Entregado' },
            ],
            requirements: { Entregado: [{ kind: 'photo', field: 'foto_entrega' }] },
            notify: { Despachado: { roles: ['supervisor'] } },
          },
        },
        { key: 'foto_entrega', label: 'Foto de entrega', type: 'file', accept: 'image' },
        { key: 'nota', label: 'Nota', type: 'longtext' },
      ],
    },
  ],
  roles: [
    {
      key: 'operario',
      name: 'Operario',
      description: 'Recibe y entrega',
      permissions: {
        tables: { envios: { read: 'all', create: true, edit: 'all', actions: [] } },
        export: false,
      },
    },
    {
      key: 'supervisor',
      name: 'Supervisor',
      description: 'Despacha',
      permissions: {
        tables: { envios: { read: 'all', create: true, edit: 'all', actions: [] } },
        export: true,
      },
    },
  ],
  screens: [
    {
      title: 'Envíos',
      slug: 'envios',
      icon: 'Package',
      roles: [],
      spec: {
        version: 1,
        editing: 'team',
        accent: 'primary',
        refreshSeconds: 30,
        blocks: [
          {
            id: 'total',
            type: 'metric',
            width: 'third',
            tracker: 'envios',
            title: 'Envíos',
            agg: 'count',
          },
          {
            id: 'lista',
            type: 'cards',
            width: 'full',
            tracker: 'envios',
            title: 'Por dónde van',
            titleField: 'guia',
            subtitleField: 'cliente',
            statusField: 'estado',
            dataFields: ['valor'],
            chips: ['status'],
          },
          {
            id: 'ficha',
            type: 'detail',
            width: 'full',
            tracker: 'envios',
            titleField: 'guia',
            subtitleField: 'cliente',
            statusField: 'estado',
            sections: [{ title: 'El envío', fields: ['cliente', 'valor', 'nota'] }],
            gallery: ['foto_entrega'],
            timeline: { limit: 20 },
          },
        ],
      },
    },
    {
      title: 'Registrar',
      slug: 'registrar',
      icon: 'ClipboardPlus',
      roles: ['operario'],
      spec: {
        version: 1,
        editing: 'team',
        accent: 'primary',
        refreshSeconds: 60,
        theme: { layout: 'operator' },
        blocks: [
          {
            id: 'nuevo',
            type: 'form',
            width: 'full',
            tracker: 'envios',
            title: 'Registrar envío',
            fields: ['guia', 'cliente', 'valor', 'nota'],
            submitLabel: 'Registrar',
            successMessage: 'Envío registrado.',
          },
        ],
      },
    },
  ],
  homeScreen: 'envios',
});

/** La vista previa de cada rol, calculada con filas de ejemplo (y, si se pide, la ficha abierta). */
export function sampleFixtures(openFirstRecord: boolean): Record<string, AppPreview> {
  const out: Record<string, AppPreview> = {};
  const now = new Date();
  for (const key of ['administrador', ...SAMPLE_DRAFT.roles.map((r) => r.key)]) {
    // La ficha abierta necesita el id de una fila de ejemplo: el primero.
    const base = buildAppPreview(SAMPLE_DRAFT, [], { roleKey: key, now });
    const open = openFirstRecord
      ? (() => {
          const view = base.views.envios;
          const detail = view?.blocks.find((b) => b.type === 'detail');
          const cards = view?.blocks.find((b) => b.type === 'cards');
          const rowId = cards && cards.type === 'cards' ? cards.cards[1]?.id : undefined;
          return detail && rowId
            ? buildAppPreview(SAMPLE_DRAFT, [], {
                roleKey: key,
                now,
                record: { screen: 'envios', blockId: detail.id, rowId },
              })
            : base;
        })()
      : base;
    out[key] = open;
  }
  return out;
}
