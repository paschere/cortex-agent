/**
 * LOS PRIMEROS 15 MINUTOS: la máquina de pasos.
 *
 * Pura (sin red ni base): recibe qué hechos hay en la empresa y devuelve los
 * cuatro pasos con su estado, el avance y cuánto falta. El servidor la usa
 * para decidir si /onboarding enseña el recorrido guiado; el cliente, para
 * pintar la barra. Nada de esto se guarda: «hecho» se deriva siempre de los
 * datos, igual que `readOnboarding`.
 */

export const STEP_IDS = ['empresa', 'fuentes', 'cuentale', 'resumen'] as const;
export type StepId = (typeof STEP_IDS)[number];

export type InterviewState = 'none' | 'talking' | 'proposed' | 'applied';

export interface FirstRunFacts {
  /** Alguien ya tocó un interruptor de módulos («¿qué hace tu empresa?»). */
  modulesAnswered: boolean;
  googleConnected: boolean;
  accountingConnected: boolean;
  whatsappConnected: boolean;
  interviewState: InterviewState;
  autopilotEnabled: boolean;
}

export type StepStatus = 'done' | 'current' | 'todo';

export interface FlowStep {
  id: StepId;
  /** Número visible, desde 1. */
  n: number;
  title: string;
  /** Una línea: qué se hace aquí. */
  blurb: string;
  /** Minutos que promete este paso. */
  minutes: number;
  status: StepStatus;
}

export interface Flow {
  steps: FlowStep[];
  current: StepId | null;
  doneCount: number;
  /** 0–100. */
  percent: number;
  minutesLeft: number;
  /** Los cuatro hechos: el recorrido ya no hace falta. */
  complete: boolean;
}

export const TOTAL_MINUTES = 15;

const COPY: Record<StepId, { title: string; blurb: string; minutes: number }> = {
  empresa: {
    title: 'Qué hace tu empresa',
    blurb: 'Elige el tipo de empresa y Cortex prende solo lo que te sirve.',
    minutes: 2,
  },
  fuentes: {
    title: 'Conecta tus fuentes',
    blurb: 'Google (Drive, Gmail, Sheets), tu programa contable y WhatsApp.',
    minutes: 5,
  },
  cuentale: {
    title: 'Cuéntale a Cortex',
    blurb: 'Una conversación corta: Cortex propone tablas, vistas y automatizaciones.',
    minutes: 5,
  },
  resumen: {
    title: 'Tu primer resumen',
    blurb: 'Lo que Cortex ya encontró en tus datos, con el siguiente paso de cada hallazgo.',
    minutes: 3,
  },
};

/** ¿Está hecho este paso, según los datos? */
export function isStepDone(id: StepId, f: FirstRunFacts): boolean {
  switch (id) {
    case 'empresa':
      return f.modulesAnswered;
    case 'fuentes':
      return f.googleConnected || f.accountingConnected || f.whatsappConnected;
    case 'cuentale':
      return f.interviewState === 'applied';
    case 'resumen':
      return f.autopilotEnabled;
  }
}

export function buildFlow(f: FirstRunFacts): Flow {
  const doneFlags = STEP_IDS.map((id) => isStepDone(id, f));
  const firstOpen = doneFlags.findIndex((d) => !d);
  const steps: FlowStep[] = STEP_IDS.map((id, i) => ({
    id,
    n: i + 1,
    ...COPY[id],
    status: doneFlags[i] ? 'done' : i === firstOpen ? 'current' : 'todo',
  }));
  const doneCount = doneFlags.filter(Boolean).length;
  const minutesLeft = steps.filter((s) => s.status !== 'done').reduce((a, s) => a + s.minutes, 0);
  return {
    steps,
    current: firstOpen === -1 ? null : (STEP_IDS[firstOpen] ?? null),
    doneCount,
    percent: Math.round((doneCount / STEP_IDS.length) * 100),
    minutesLeft,
    complete: firstOpen === -1,
  };
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value);
}

/**
 * El paso que se enseña: el pedido en la URL si es válido; si no, el actual;
 * y con todo hecho, el último (el resumen sigue siendo útil).
 */
export function resolveStep(requested: unknown, flow: Flow): StepId {
  if (isStepId(requested)) return requested;
  return flow.current ?? 'resumen';
}

/** La frase de la promesa de tiempo. */
export function timePromise(flow: Flow): string {
  if (flow.complete) return 'Listo: tu Cortex ya está en marcha.';
  if (flow.doneCount === 0) return `≈${TOTAL_MINUTES} min para ver tus propios datos trabajando.`;
  return `Faltan ≈${flow.minutesLeft} min.`;
}

/** ¿/onboarding enseña el recorrido guiado? Sólo mientras falte algo y nadie lo cierre. */
export function shouldShowFirstRun(flow: Flow, opts: { full?: boolean } = {}): boolean {
  return !flow.complete && !opts.full;
}
