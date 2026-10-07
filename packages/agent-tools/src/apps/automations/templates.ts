import type { AutomationInput } from './spec';

/**
 * PLANTILLAS LISTAS (0210). Cada una arma una regla completa a partir de unos
 * pocos datos que una persona sabe contestar (¿qué tabla?, ¿qué rol?, ¿qué
 * campo y a qué valor?). Salen del editor («Empezar desde una plantilla») y del
 * chat. Siguen siendo reglas normales: después se editan como cualquier otra.
 */

export interface AutomationTemplateParams {
  tracker?: string;
  role?: string;
  field?: string;
  value?: string;
  emails?: string[];
  hour?: number;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  /** Qué hay que preguntar para armarla. */
  needs: Array<'tracker' | 'role' | 'field' | 'value' | 'emails'>;
  build(p: AutomationTemplateParams): AutomationInput;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === '') throw new Error(`Falta ${what}.`);
  return v;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'duplicate_to_supervisor',
    name: 'Avisar al supervisor cuando haya un duplicado',
    description:
      'Cuando una fila queda marcada como duplicada, avisa por push (o correo si no tiene push) a quienes tienen el rol de supervisor y deja una campana a los miembros con ese rol.',
    needs: ['tracker', 'role'],
    build: (p) => ({
      name: 'Avisar al supervisor cuando haya un duplicado',
      enabled: true,
      trigger: { type: 'row_flagged_duplicate', tracker: need(p.tracker, 'la tabla') },
      conditions: [],
      actions: [
        {
          type: 'notify_app_user',
          to: { role: need(p.role, 'el rol del supervisor') },
          title: 'Posible duplicado: {{nombre}}',
          body: 'Entró un registro que choca con otro. Revísalo y resuelve cuál queda.',
        },
        {
          type: 'notify_member',
          members: [],
          roles: [need(p.role, 'el rol del supervisor')],
          admins: false,
          title: 'Posible duplicado: {{nombre}}',
          body: 'Revísalo en «{{app}}».',
        },
      ],
    }),
  },
  {
    id: 'rejected_to_operator',
    name: 'Avisar al operario si le rechazan',
    description:
      'Cuando se rechaza una fila, avisa a quien la creó (push, o correo si no tiene push) con el motivo.',
    needs: ['tracker'],
    build: (p) => ({
      name: 'Avisar al operario si le rechazan',
      enabled: true,
      trigger: {
        type: 'approval_decided',
        tracker: need(p.tracker, 'la tabla'),
        decision: 'rejected',
      },
      conditions: [],
      actions: [
        {
          type: 'notify_app_user',
          to: 'creator',
          title: 'Te rechazaron «{{nombre}}»',
          body: '{{motivo}}',
        },
      ],
    }),
  },
  {
    id: 'daily_summary',
    name: 'Resumen diario a gerencia',
    description:
      'Todos los días a la hora elegida (hora de Bogotá) manda un correo al rol de gerencia con el enlace de la app. Para cifras en el correo usa además el resumen periódico de una vista.',
    needs: ['role'],
    build: (p) => ({
      name: 'Resumen diario a gerencia',
      enabled: true,
      trigger: { type: 'schedule', cadence: 'daily', hour: p.hour ?? 7 },
      conditions: [],
      actions: [
        {
          type: 'email',
          to: p.emails ?? [],
          roles: p.role ? [p.role] : [],
          subject: 'Resumen del día · {{app}}',
          body: 'Buen día. El tablero de «{{app}}» ya tiene los datos de ayer: {{enlace}}',
        },
      ],
    }),
  },
  {
    id: 'approved_to_dispatched',
    name: 'Pasar a «Despachada» cuando se apruebe',
    description:
      'Cuando se aprueba una fila, cambia su campo de estado al valor elegido (por ejemplo Despachada).',
    needs: ['tracker', 'field', 'value'],
    build: (p) => ({
      name: `Pasar a «${p.value ?? 'Despachada'}» cuando se apruebe`,
      enabled: true,
      trigger: {
        type: 'approval_decided',
        tracker: need(p.tracker, 'la tabla'),
        decision: 'approved',
      },
      conditions: [],
      actions: [
        {
          type: 'set_field',
          field: need(p.field, 'el campo de estado'),
          value: need(p.value, 'el valor al que pasa'),
        },
      ],
    }),
  },
];

export function templateById(id: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
