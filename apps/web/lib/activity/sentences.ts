import { toolLabel } from '../tool-labels';
import { detailOf, people, str } from './detail';
import type { ActivityEvent, ActivityGroup, ActivityHow } from './types';

/**
 * DE UNA FILA DE AUDITORÍA A UNA FRASE.
 *
 * «Envié un correo a ana@x.com», «Anoté una fila en Vuelos», «Archivé la vista
 * Ventas». Se arma con lo que la fila guarda en `metadata.detail` (entrada y
 * resultado recortados y sin secretos) y, cuando una herramienta no tiene frase
 * propia, con su etiqueta de `tool-labels.ts` puesta en pasado y en primera
 * persona. Nunca se muestra un valor que `sanitizeForAudit` tapó.
 */

export interface Described {
  text: string;
  group: ActivityGroup;
  /**
   * Para juntar filas seguidas que dicen lo mismo («Anoté 3 filas en Vuelos»):
   * misma clave = misma frase en plural. `null` = no se junta.
   */
  collapse: { key: string; build: (n: number) => string } | null;
}

// --- Verbos: etiqueta en infinitivo -> primera persona del pasado -------------

const IRREGULAR: Record<string, string> = {
  hacer: 'Hice',
  poner: 'Puse',
  decir: 'Dije',
  dar: 'Di',
  ver: 'Vi',
  traer: 'Traje',
  ir: 'Fui',
  leer: 'Leí',
};

/** «Crear una vista» -> «Creé una vista». Si no empieza con verbo, «Usé: …». */
export function pastFirstPerson(label: string): string {
  const [first = '', ...rest] = label.trim().split(/\s+/);
  const lower = first.toLowerCase();
  const tail = rest.length ? ` ${rest.join(' ')}` : '';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (IRREGULAR[lower]) return `${IRREGULAR[lower]}${tail}`;
  if (/^[a-záéíóúñ]{3,}(ar|er|ir)$/.test(lower)) {
    const stem = lower.slice(0, -2);
    const end = lower.slice(-2);
    let out: string;
    if (end === 'ar') {
      if (stem.endsWith('c')) out = `${stem.slice(0, -1)}qué`;
      else if (stem.endsWith('g')) out = `${stem}ué`;
      else if (stem.endsWith('z')) out = `${stem.slice(0, -1)}cé`;
      else out = `${stem}é`;
    } else out = `${stem}í`;
    return `${cap(out)}${tail}`;
  }
  return `Usé: ${label}`;
}

// --- Sentencias propias --------------------------------------------------------

type Builder = (ctx: {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  failed: boolean;
}) => Described | null;

const plain = (text: string, group: ActivityGroup): Described => ({
  text,
  group,
  collapse: null,
});

const quoted = (v: unknown, max = 60): string => {
  const s = str(v, max);
  return s ? `«${s}»` : '';
};

function clientSuffix(input: Record<string, unknown>): string {
  const c = str(input.client, 40) ?? str(input.clientName, 40);
  return c ? ` (cliente ${c})` : '';
}

const BUILDERS: Record<string, Builder> = {
  gmail_send_message: ({ input }) => {
    const to = people(input.to);
    const subject = quoted(input.subject);
    return plain(
      `Envié un correo${to ? ` a ${to}` : ''}${clientSuffix(input)}${subject ? ` — ${subject}` : ''}`,
      'email',
    );
  },
  gmail_send_draft: () => plain('Envié un correo que tenía redactado', 'email'),
  outlook_send_draft: ({ result }) => {
    const to = str(result.to, 60);
    return plain(`Envié un correo${to ? ` a ${to}` : ''}`, 'email');
  },
  outlook_send_message: ({ input }) => {
    const to = people(input.to);
    return plain(`Envié un correo${to ? ` a ${to}` : ''}${clientSuffix(input)}`, 'email');
  },
  gmail_draft: ({ input }) => {
    const to = people(input.to);
    return plain(`Dejé un borrador de correo${to ? ` para ${to}` : ''}`, 'email');
  },
  sales_quote_send: ({ input }) => {
    const to = people(input.to);
    return plain(`Mandé una cotización${to ? ` a ${to}` : ' por correo'}`, 'email');
  },
  board_send: () => plain('Mandé el informe para socios por correo', 'email'),
  whatsapp_reply: () => plain('Respondí un mensaje de WhatsApp', 'message'),
  whatsapp_group_send: ({ input }) => {
    const g = quoted(input.group, 40);
    return plain(`Escribí en el grupo de WhatsApp${g ? ` ${g}` : ''}`, 'message');
  },
  gcal_create_event: ({ input }) => {
    const s = quoted(input.summary);
    return plain(`Creé el evento${s ? ` ${s}` : ''} en el calendario`, 'calendar');
  },
  gsheets_append_row: () => plain('Agregué una fila a una hoja de cálculo', 'rows'),
  trackers_upsert: ({ input, result }) => {
    const tracker = result.tracker as Record<string, unknown> | undefined;
    const name = str(tracker?.name, 50) ?? str(input.tracker, 50) ?? 'una tabla';
    const created = result.created === true || (result.created === undefined && !input.rowId);
    if (created) {
      return {
        text: `Anoté una fila en ${name}`,
        group: 'rows',
        collapse: {
          key: `rows:create:${name}`,
          build: (n) => (n === 1 ? `Anoté una fila en ${name}` : `Anoté ${n} filas en ${name}`),
        },
      };
    }
    const row = result.row as Record<string, unknown> | undefined;
    const label = quoted(row?.label ?? input.label);
    return {
      text: `Actualicé${label ? ` la fila ${label}` : ' una fila'} en ${name}`,
      group: 'rows',
      collapse: {
        key: `rows:update:${name}`,
        build: (n) =>
          n === 1
            ? `Actualicé${label ? ` la fila ${label}` : ' una fila'} en ${name}`
            : `Actualicé ${n} filas en ${name}`,
      },
    };
  },
  trackers_remove: ({ input }) => {
    const name = str(input.tracker, 50) ?? 'una tabla';
    return plain(input.rowId ? `Borré una fila de ${name}` : `Eliminé la tabla ${name}`, 'rows');
  },
  trackers_define: ({ input }) =>
    plain(`Creé o cambié la tabla ${str(input.name ?? input.slug, 50) ?? ''}`.trim(), 'rows'),
  views_create: ({ input }) => plain(`Creé la vista ${quoted(input.name)}`.trim(), 'view'),
  views_update: ({ input }) =>
    plain(`Cambié la vista ${quoted(input.view ?? input.name)}`.trim(), 'view'),
  views_archive: ({ input }) => plain(`Archivé la vista ${quoted(input.view)}`.trim(), 'view'),
  views_restore: ({ input }) => plain(`Restauré la vista ${quoted(input.view)}`.trim(), 'view'),
  views_share: ({ input }) => plain(`Compartí la vista ${quoted(input.view)}`.trim(), 'view'),
  views_delete: ({ input }) => plain(`Borré la vista ${quoted(input.view)}`.trim(), 'view'),
  payables_record: ({ input }) =>
    plain(
      `Anoté la factura${input.number ? ` ${str(input.number, 30)}` : ''} de ${str(input.supplierName, 50) ?? 'un proveedor'}`,
      'money',
    ),
  payables_approve: ({ input }) => {
    const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
    return plain(
      `Aprobé ${n === 1 ? 'una factura' : `${n || 'varias'} facturas`} de proveedor`,
      'money',
    );
  },
  payables_schedule: ({ input }) => {
    const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
    return plain(
      `Programé el pago de ${n === 1 ? 'una factura' : `${n || 'varias'} facturas`}`,
      'money',
    );
  },
  sales_invoice_emit: ({ input }) =>
    plain(`Emití la factura electrónica de ${str(input.document, 40) ?? 'un documento'}`, 'money'),
  sales_quote_create: ({ input }) =>
    plain(`Creé una cotización para ${str(input.client, 50) ?? 'un cliente'}`, 'document'),
  crm_log_activity: ({ input }) =>
    plain(`Anoté ${quoted(input.title)} en el seguimiento comercial`.replace('  ', ' '), 'other'),
  schedule_create: ({ input }) => plain(`Programé la rutina ${quoted(input.name)}`.trim(), 'other'),
  goals_set: ({ input }) =>
    plain(`Fijé la meta ${quoted(input.label ?? input.metricKey)}`.trim(), 'other'),
};

/** `delegated`/rutina -> solo; `confirmed` -> aprobado; el resto, pedido directo. */
export function howOf(
  event: Pick<ActivityEvent, 'decision' | 'surface' | 'mandate_id'>,
): ActivityHow {
  if (event.decision === 'delegated' || event.mandate_id || event.surface === 'schedule')
    return 'auto';
  if (event.decision === 'confirmed') return 'approved';
  return 'direct';
}

/** Lecturas y consultas: no son «lo que hizo» Cortex para esta línea de tiempo. */
const READ_ACTION =
  /^(list|get|search|read|query|status|find|check|view|overview|summary|summarize|preview|plan|brief|report|show|lookup|inspect|explain|recent|syncs|training_status|priorities|due_digests|capture|describe|fetch|count|forecast|compare|analy[sz]e|estimate|validate|dry_run)(_|$)/;

export function isReadTool(toolId: string): boolean {
  if (toolId.startsWith('__') || toolId === 'activity.undo') return false;
  const action = toolId.includes('.') ? toolId.slice(toolId.indexOf('.') + 1) : toolId;
  return READ_ACTION.test(action);
}

/** ¿Esta fila entra en la línea de tiempo? Sólo hechos (ok) y fallos reales. */
export function isTimelineEvent(event: ActivityEvent): boolean {
  if (event.tool_id.startsWith('__')) return false;
  if (event.status !== 'ok' && event.status !== 'error') return false;
  if (event.status === 'error') {
    const reason = event.metadata?.reason;
    // Un input mal formado o un módulo apagado no es algo que Cortex «hizo».
    if (reason === 'validation' || reason === 'module_disabled') return false;
  }
  // Con detalle guardado fue una llamada con efectos, aunque su nombre suene a lectura.
  if (event.metadata?.detail) return true;
  return !isReadTool(event.tool_id);
}

export function describeEvent(event: ActivityEvent): Described {
  const failed = event.status === 'error';
  if (event.tool_id === 'activity.undo') {
    const s = str(event.metadata?.sentence, 120);
    return plain(`Deshice: ${s ?? 'una acción anterior'}`, 'other');
  }
  const { input, result } = detailOf(event);
  const key = event.tool_id.replace(/\./g, '_');
  const built = BUILDERS[key]?.({ input, result, failed });
  const base = built ?? plain(pastFirstPerson(toolLabel(event.tool_id).label), 'other');
  if (!failed) return base;
  // Un fallo no se junta con los aciertos y dice lo que no salió.
  return {
    text: `No pude completar esto: ${base.text.charAt(0).toLowerCase()}${base.text.slice(1)}`,
    group: base.group,
    collapse: null,
  };
}
