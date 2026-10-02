/**
 * LOS CINCO PASOS DEL AUTOSERVICIO.
 *
 * La guía de /onboarding tiene doce pasos y es para quien dirige la empresa:
 * encargo, metas, responsables, mandatos. Esta es la otra cara, la que ve
 * cualquiera en el Inicio: cinco cosas concretas que llevan de cero a un
 * Cortex que trabaja solo, cada una con UN botón que la resuelve.
 *
 * Todo sale de conteos; un conteo que no se pudo leer (`null`) deja el paso
 * pendiente en vez de darlo por hecho — mejor sugerir algo ya hecho que
 * esconder algo que falta.
 */

/**
 * La marca de «ya vio los primeros 10 minutos». El Inicio manda a una empresa
 * nueva allá UNA vez por navegador; después, la franja de pasos guía desde el
 * Inicio y nadie queda atrapado en un asistente.
 */
export const FIRST_STEPS_SEEN_COOKIE = 'cortex_first_steps_seen';

export type SetupEvidence = {
  /** Datos guardados en la ficha de la empresa. */
  facts: number | null;
  /** Google (correo, Drive, calendario) conectado por quien mira. */
  google: boolean | null;
  /** Tablas de la empresa, documentos en el cerebro y fuentes del Feed. */
  data: number | null;
  /** Sincronizaciones de tablas y carpetas, y rutinas activas. */
  processes: number | null;
  /** Vistas creadas. */
  views: number | null;
  /** Personas en la empresa. */
  people: number | null;
};

export type SetupStep = {
  id: 'company' | 'connect' | 'data' | 'process' | 'team';
  title: string;
  /** Lo que ya está, cuando está. */
  done: string;
  /** El botón que lo resuelve, cuando falta. */
  action: { label: string; href: string };
  ready: boolean;
};

const has = (n: number | null, min = 1) => n !== null && n >= min;

export function buildSetupSteps(e: SetupEvidence): SetupStep[] {
  return [
    {
      id: 'company',
      title: 'Cuéntale de tu empresa',
      done: 'Cortex conoce tu negocio',
      action: { label: 'Contarlo en 3 minutos', href: '/onboarding/entrevista' },
      ready: has(e.facts),
    },
    {
      id: 'connect',
      title: 'Conecta tu correo',
      done: 'Google conectado',
      action: { label: 'Conectar Google', href: '/api/integrations/google?preset=all' },
      ready: e.google === true,
    },
    {
      id: 'data',
      title: 'Trae tus datos',
      done: plural(e.data, 'fuente', 'fuentes'),
      action: { label: 'Elegir de dónde', href: '/onboarding/fuentes' },
      ready: has(e.data),
    },
    {
      id: 'process',
      title: 'Activa un proceso',
      done: plural(e.processes, 'proceso andando', 'procesos andando'),
      action: { label: 'Ver los listos', href: '/procesos' },
      ready: has(e.processes) || has(e.views),
    },
    {
      id: 'team',
      title: 'Invita a tu equipo',
      done: plural(e.people, 'persona', 'personas'),
      action: { label: 'Invitar', href: '/admin/users' },
      ready: has(e.people, 2),
    },
  ];
}

export function setupProgress(steps: SetupStep[]) {
  const ready = steps.filter((s) => s.ready).length;
  return {
    ready,
    total: steps.length,
    percent: Math.round((ready / Math.max(steps.length, 1)) * 100),
    next: steps.find((s) => !s.ready) ?? null,
    complete: ready === steps.length,
  };
}

function plural(n: number | null, one: string, many: string) {
  if (n === null) return '';
  return `${n.toLocaleString('es-CO')} ${n === 1 ? one : many}`;
}
