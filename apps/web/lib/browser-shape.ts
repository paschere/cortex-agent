/**
 * The trámites-web vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once already: green locally, red in Vercel.
 *
 * `commitments-shape.ts` and `ToolsCatalog.tsx` hit the same wall and solved it
 * the same way. Types are fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `browser-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

/**
 * WHAT THE MODULE IS CALLED, IN ONE PLACE.
 *
 * The name is not settled. `label` is what the screen, the sidebar entry and
 * the tool catalogue all read, and `one` / `many` are the noun in running
 * prose ("enséñame un trámite", "todavía no hay trámites"). Renaming the module
 * is those three strings and nothing else — the route stays `/browser`, because
 * a URL is code and code is in English.
 *
 * Only what a person reads goes through here. Identifiers, table names and the
 * agent's own tool names are unaffected by a rename and must not be templated.
 */
export const MODULE = {
  label: 'Trámites',
  one: 'trámite',
  many: 'trámites',
} as const;

/**
 * THE BEST TRÁMITE IS THE ONE NOBODY HAS TO LEARN.
 *
 * Some destinations already have a real door. Cortex talks to Gmail, Outlook
 * and HubSpot through their own APIs, with credentials each person authorises
 * and that refresh themselves. Learning a browser trámite against those would
 * be slower, far more brittle, and would make us store a password that today
 * does not need storing — a strictly worse version of something that already
 * works.
 *
 * So when a recording turns out to be aimed at one of them, the review step
 * says so and points at Integraciones instead of saving it. The browser is for
 * what has no other door: the state portals, the customers' own systems, the
 * supplier software from 2009.
 *
 * Matched on the registrable suffix so `mail.google.com` and
 * `accounts.google.com` both resolve, and `notgoogle.com.co` does not.
 */
const ALREADY_CONNECTED: { suffixes: string[]; service: string; where: string }[] = [
  {
    suffixes: ['google.com', 'gmail.com', 'googlemail.com', 'googleusercontent.com'],
    service: 'Google',
    where: 'tu correo, tu calendario y tu Drive',
  },
  {
    suffixes: [
      'microsoftonline.com',
      'outlook.com',
      'office.com',
      'office365.com',
      'live.com',
      'sharepoint.com',
      'microsoft.com',
    ],
    service: 'Microsoft',
    where: 'tu correo y tu calendario de Outlook',
  },
  { suffixes: ['hubspot.com'], service: 'HubSpot', where: 'tus contactos y negocios' },
];

export interface AlreadyConnected {
  service: string;
  where: string;
}

/** The integration that makes learning this trámite unnecessary, if there is one. */
export function alreadyConnected(startUrl: string): AlreadyConnected | null {
  let host: string;
  try {
    host = new URL(startUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const entry of ALREADY_CONNECTED) {
    for (const suffix of entry.suffixes) {
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return { service: entry.service, where: entry.where };
      }
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * QUÉ PRODUCE Y DÓNDE LLEGA (migration 0093)
 * -------------------------------------------------------------------------*/

/**
 * What the errand comes back with. Decides what a notification can SAY: the
 * difference between «el trámite corrió» and «el certificado de tradición de
 * ABC123 está listo» is entirely here.
 */
export const OUTPUT_KINDS = ['document', 'data', 'confirmation'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const OUTPUT_KIND_LABEL: Record<OutputKind, string> = {
  document: 'Un documento',
  data: 'Un dato',
  confirmation: 'Sólo saber que salió bien',
};

export const OUTPUT_KIND_HINT: Record<OutputKind, string> = {
  document: 'El certificado, el paz y salvo, el extracto: algo que se descarga.',
  data: 'Un valor de la última pantalla: un estado, una fecha, un monto.',
  confirmation: 'No trae nada que guardar; la noticia es que funcionó.',
};

/**
 * Where the result lands. There is no «para:» — siempre le llega a quien pidió
 * el trámite. La razón está en la migración: un destinatario libre aquí sería
 * la única forma sin revisar de que un dato de la empresa salga de la empresa.
 */
export const DELIVER_TO = ['none', 'chat', 'email'] as const;
export type DeliverTo = (typeof DELIVER_TO)[number];

export const DELIVER_TO_LABEL: Record<DeliverTo, string> = {
  none: 'Guardado y ya',
  chat: 'Avísame en el chat',
  email: 'Mándamelo por correo',
};

export const DELIVER_TO_HINT: Record<DeliverTo, string> = {
  none: 'Queda en la pantalla del trámite, con su resultado y su hora.',
  chat: 'Un mensaje en la conversación donde se pidió.',
  email: 'A tu correo. Y como Chat de Google, si lo tienes vinculado.',
};

export const DELIVER_WHEN = ['always', 'failure'] as const;
export type DeliverWhen = (typeof DELIVER_WHEN)[number];

export const DELIVER_WHEN_LABEL: Record<DeliverWhen, string> = {
  always: 'Siempre',
  failure: 'Sólo cuando falle',
};

export interface FlowDelivery {
  outputKind: OutputKind;
  outputLabel: string;
  deliverTo: DeliverTo;
  deliverWhen: DeliverWhen;
}

export const DEFAULT_DELIVERY: FlowDelivery = {
  outputKind: 'confirmation',
  outputLabel: '',
  deliverTo: 'none',
  deliverWhen: 'always',
};

/**
 * Lo que produce el trámite, leído de la propia grabación.
 *
 * Asking somebody cold what their errand produces gets «pues… el trámite». Ask
 * them right after they taught it, with the answer already filled in from what
 * the recording did, and they either nod or correct one word. A `download`
 * step means a document and the step's own label is what it is called; an
 * `extract` step means a datum and the name it was extracted under is what it
 * is called. Neither is a guess about intent — both are what the recording
 * literally contains.
 *
 * The last matching step wins: an errand that downloads two things ends on the
 * one it went there for.
 */
export function proposeOutput(steps: ProposedStep[]): {
  outputKind: OutputKind;
  outputLabel: string;
} {
  let found: { outputKind: OutputKind; outputLabel: string } | null = null;
  for (const step of steps) {
    if (step.action === 'download') {
      found = { outputKind: 'document', outputLabel: step.label.trim() };
    } else if (step.action === 'extract' && !found) {
      const name = (step.extractAs ?? '').replaceAll(/[._-]/g, ' ').trim();
      found = { outputKind: 'data', outputLabel: name || step.label.trim() };
    }
  }
  return found ?? { outputKind: 'confirmation', outputLabel: '' };
}

/** What a flow does to the site it runs on. Decides whether it needs approval. */
export const FLOW_EFFECTS = ['read', 'write'] as const;
export type FlowEffect = (typeof FLOW_EFFECTS)[number];

/**
 * `draft` is PROPUESTO and `ready` is PROBADO, and the screen says those two
 * words rather than "borrador" and "listo". The distinction is not about
 * polish, it is about whether anybody has ever seen the errand work — which is
 * the only question that matters the day somebody schedules one to run at 3am.
 */
export const FLOW_STATUSES = ['draft', 'ready', 'broken'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'wait_for',
  'extract',
  'download',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const TARGET_KINDS = [
  'testid',
  'role',
  'label',
  'placeholder',
  'text',
  'name',
  'css',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const EFFECT_LABEL: Record<FlowEffect, string> = {
  read: 'Consulta',
  write: 'Radica o envía',
};

export const STATUS_LABEL: Record<FlowStatus, string> = {
  draft: 'Propuesto',
  ready: 'Probado',
  broken: 'Roto',
};

/** Rose is reserved for the irreversible; a proposal is not a failure. */
export const STATUS_TONE: Record<FlowStatus, 'emerald' | 'amber' | 'rose'> = {
  draft: 'amber',
  ready: 'emerald',
  broken: 'rose',
};

export const ACTION_LABEL: Record<StepAction, string> = {
  goto: 'Ir a',
  click: 'Hacer clic en',
  fill: 'Escribir en',
  select: 'Elegir en',
  check: 'Marcar',
  uncheck: 'Desmarcar',
  press: 'Presionar tecla en',
  wait_for: 'Esperar',
  extract: 'Leer',
  download: 'Descargar desde',
};

export const TARGET_LABEL: Record<TargetKind, string> = {
  testid: 'identificador de prueba',
  role: 'tipo y nombre visible',
  label: 'rótulo del campo',
  placeholder: 'texto de ayuda',
  text: 'texto visible',
  name: 'nombre del campo',
  css: 'ruta en el HTML',
};

/** Why the ranking is what it is, in one line each, for the flow detail screen. */
export const TARGET_WHY: Record<TargetKind, string> = {
  testid: 'Puesto ahí a propósito para que un robot lo encuentre. No cambia.',
  role: 'Lo que el elemento es más lo que dice. Sobrevive a un rediseño.',
  label: 'El rótulo impreso al lado del campo, que es lo que lee una persona.',
  placeholder: 'El texto gris de adentro. Se reescribe más seguido que un rótulo.',
  text: 'Las palabras del enlace o del botón.',
  name: 'El nombre interno del campo. Los portales del Estado casi nunca lo tocan.',
  css: 'La posición en el HTML. Es el primero que se rompe.',
};

/** Shapes the API returns. Kept here so the client never imports the barrel. */
export interface FlowSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  site: string;
  startUrl: string;
  effect: FlowEffect;
  status: FlowStatus;
  version: number;
  verifiedAt: string | null;
  hasCredential: boolean;
  variables: { name: string; label: string; example: string; required: boolean }[];
  stepCount: number;
  /** Qué produce y dónde llega. See migration 0093. */
  delivery: FlowDelivery;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastRunSeconds: number | null;
  lastRunCostUsd: number | null;
}

export interface ProposedTarget {
  kind: TargetKind;
  value: string;
  name?: string;
}

export interface ProposedStep {
  action: StepAction;
  label: string;
  targets: ProposedTarget[];
  value?:
    | { kind: 'literal'; text: string }
    | { kind: 'template'; text: string }
    | { kind: 'secret'; field: string };
  url?: string;
  expect?: string;
  landmarks: string[];
  optional?: boolean;
  extractAs?: string;
}

export interface Proposal {
  name: string;
  description: string;
  startUrl: string;
  effect: FlowEffect;
  variables: { name: string; label: string; example: string; required: boolean }[];
  steps: ProposedStep[];
  notes: string[];
}
