import { colombianHolidays } from '../management/follow-up';
import type { PqrsKind, PqrsMatter } from './shape';

/**
 * EL PLAZO DE UNA PQRS, EN DÍAS HÁBILES COLOMBIANOS.
 *
 * ===========================================================================
 * DE DÓNDE SALE CADA PLAZO
 * ===========================================================================
 *   - Petición en general: 15 días hábiles (Ley 1755 de 2015, art. 14), que
 *     también rige ante organizaciones privadas (art. 32).
 *   - Petición de documentos o información: 10 días hábiles (art. 14 num. 1).
 *   - Consulta (un concepto): 30 días hábiles (art. 14 num. 2).
 *   - Datos personales (habeas data): consulta, 10 días hábiles; reclamo, 15
 *     días hábiles (Ley 1581 de 2012, arts. 14 y 15).
 *   - Queja o reclamo de un consumidor: 15 días hábiles por defecto (la regla
 *     general del derecho de petición; el Estatuto del Consumidor, Ley 1480
 *     de 2011, y sus reglamentos fijan plazos propios para algunos trámites,
 *     como la garantía) — SALE MARCADO POR CONFIRMAR.
 *   - Sugerencias y felicitaciones: la ley no fija plazo; se usan 15 días
 *     hábiles como plazo INTERNO, y se dice así.
 * Cada empresa puede fijar el suyo por clase en el perfil
 * (`pqrs_deadlines`), siempre más corto o igual; Cortex no lo alarga.
 *
 * Ampliación: si no se puede responder a tiempo, se avisa ANTES de que venza,
 * con las razones y el nuevo plazo, que no puede exceder el doble del inicial
 * (Ley 1755 de 2015, art. 14, parágrafo).
 *
 * ===========================================================================
 * CÓMO SE CUENTA
 * ===========================================================================
 * Desde el día hábil siguiente al de la recepción: el día en que llegó no
 * cuenta. Hábiles son lunes a viernes que no sean festivos nacionales (los 18
 * de `colombianHolidays`, y desde 2026 el de la Ley 2578 de 2026, que cae el
 * lunes siguiente al 9 de julio). Lo que llega un sábado se empieza a contar
 * el lunes. La hora de recepción no se mira (lo que llega después del cierre
 * de la oficina, en la práctica, se radica al día siguiente: confírmalo con tu
 * abogado si te importa ese día).
 */

const DAY = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function shift(day: string, n: number): string {
  return iso(new Date(toUtc(day).getTime() + n * DAY));
}

/** El lunes siguiente (o el mismo día si ya es lunes): Ley Emiliani. */
function mondayFrom(day: string): string {
  const dow = toUtc(day).getUTCDay();
  return dow === 1 ? day : shift(day, (8 - dow) % 7);
}

const cache = new Map<number, ReadonlySet<string>>();

/** Festivos nacionales del año, con el de la Ley 2578 de 2026 desde 2026. */
export function pqrsHolidays(year: number): ReadonlySet<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const set = new Set(colombianHolidays(year));
  if (year >= 2026) set.add(mondayFrom(`${year}-07-09`));
  cache.set(year, set);
  return set;
}

export function isBusinessDayCo(day: string): boolean {
  const d = toUtc(day);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !pqrsHolidays(d.getUTCFullYear()).has(day);
}

/** El día en que se cumplen `n` días hábiles contados desde el siguiente a `from`. */
export function addBusinessDays(from: string, n: number): string {
  let day = from;
  let counted = 0;
  // Tope: 90 días hábiles caben en menos de 200 días calendario.
  for (let guard = 0; counted < n && guard < 400; guard++) {
    day = shift(day, 1);
    if (isBusinessDayCo(day)) counted++;
  }
  return day;
}

/**
 * Días hábiles que quedan hasta `due` (contando `due`), o negativos si ya
 * pasó: -1 = venció el día hábil anterior. Cero = vence hoy.
 */
export function businessDaysLeft(today: string, due: string): number {
  if (today === due) return 0;
  let count = 0;
  if (today < due) {
    for (let d = shift(today, 1), g = 0; d <= due && g < 400; d = shift(d, 1), g++) {
      if (isBusinessDayCo(d)) count++;
    }
    return count;
  }
  for (let d = shift(due, 1), g = 0; d <= today && g < 400; d = shift(d, 1), g++) {
    if (isBusinessDayCo(d)) count++;
  }
  return -count;
}

export interface LegalDeadline {
  days: number;
  basis: string;
  /** El plazo no está fijado con certeza para esta clase: confírmalo. */
  needsConfirmation: boolean;
  /** Fijado por la empresa (más corto que el legal). */
  custom: boolean;
}

/** El plazo legal (o interno) de una PQRS, por clase y materia. */
export function legalDeadline(
  kind: PqrsKind,
  matter: PqrsMatter,
  overrides: Record<string, number> = {},
): LegalDeadline {
  let base: LegalDeadline;
  if (matter === 'datos_personales') {
    base =
      kind === 'reclamo' || kind === 'queja'
        ? {
            days: 15,
            basis: 'Reclamo de datos personales: 15 días hábiles (Ley 1581 de 2012, art. 15).',
            needsConfirmation: false,
            custom: false,
          }
        : {
            days: 10,
            basis: 'Consulta de datos personales: 10 días hábiles (Ley 1581 de 2012, art. 14).',
            needsConfirmation: false,
            custom: false,
          };
  } else if (kind === 'sugerencia' || kind === 'felicitacion') {
    base = {
      days: 15,
      basis:
        'La ley no fija plazo para sugerencias y felicitaciones: 15 días hábiles como plazo interno.',
      needsConfirmation: false,
      custom: false,
    };
  } else if (matter === 'informacion') {
    base = {
      days: 10,
      basis:
        'Petición de documentos o información: 10 días hábiles (Ley 1755 de 2015, art. 14 num. 1).',
      needsConfirmation: false,
      custom: false,
    };
  } else if (matter === 'consulta') {
    base = {
      days: 30,
      basis: 'Consulta: 30 días hábiles (Ley 1755 de 2015, art. 14 num. 2).',
      needsConfirmation: false,
      custom: false,
    };
  } else if (matter === 'consumo') {
    base = {
      days: 15,
      basis:
        'Queja o reclamo de consumo: 15 días hábiles por la regla general (Ley 1755 de 2015, art. 14); el Estatuto del Consumidor (Ley 1480 de 2011) fija plazos propios para algunos trámites, como la garantía. Confírmalo.',
      needsConfirmation: true,
      custom: false,
    };
  } else {
    base = {
      days: 15,
      basis: 'Petición: 15 días hábiles (Ley 1755 de 2015, arts. 14 y 32).',
      needsConfirmation: false,
      custom: false,
    };
  }
  const own = overrides[kind] ?? overrides[matter];
  if (typeof own === 'number' && Number.isInteger(own) && own >= 1 && own < base.days) {
    return {
      days: own,
      basis: `Plazo interno de la empresa: ${own} días hábiles (el legal es de ${base.days}).`,
      needsConfirmation: false,
      custom: true,
    };
  }
  return base;
}

/** La fecha más lejana a la que se puede ampliar: el doble del plazo inicial. */
export function maxExtensionDate(receivedOn: string, days: number): string {
  return addBusinessDays(receivedOn, days * 2);
}

export function formatRadicado(year: number, seq: number): string {
  return `PQRS-${year}-${String(seq).padStart(6, '0')}`;
}

export type DeadlineTone = 'emerald' | 'amber' | 'rose' | 'neutral';

/** Cómo se dice lo que queda: «vence hoy», «quedan 3 días hábiles», «vencida hace 2». */
export function deadlinePhrase(left: number): { text: string; tone: DeadlineTone } {
  if (left < 0) {
    const n = -left;
    return { text: `vencida hace ${n} ${n === 1 ? 'día hábil' : 'días hábiles'}`, tone: 'rose' };
  }
  if (left === 0) return { text: 'vence hoy', tone: 'rose' };
  return {
    text: `${left === 1 ? 'queda 1 día hábil' : `quedan ${left} días hábiles`}`,
    tone: left <= 3 ? 'amber' : 'emerald',
  };
}

// ---------------------------------------------------------------------------
// Plantillas de respuesta (borradores)
// ---------------------------------------------------------------------------

export interface ResponseTemplate {
  key: 'acuse' | 'fondo' | 'ampliacion' | 'informacion' | 'traslado' | 'felicitacion';
  label: string;
  text: string;
}

/**
 * Borradores de respuesta con marcadores {nombre}, {radicado}, {fecha},
 * {empresa}, {asunto}, {plazo}. La respuesta de fondo la escribe una persona:
 * aquí sólo está la forma.
 */
export const RESPONSE_TEMPLATES: readonly ResponseTemplate[] = [
  {
    key: 'acuse',
    label: 'Acuse de recibo',
    text: 'Hola, {nombre}:\n\nRecibimos tu solicitud «{asunto}» el {fecha} y quedó radicada con el número {radicado}. Te responderemos a más tardar el {plazo}.\n\nCordialmente,\n{empresa}',
  },
  {
    key: 'fondo',
    label: 'Respuesta de fondo',
    text: 'Hola, {nombre}:\n\nEn respuesta a tu solicitud {radicado} del {fecha} («{asunto}»), te informamos:\n\n[COMPLETAR: la respuesta clara, completa y de fondo a cada punto que planteaste]\n\nSi tienes preguntas sobre esta respuesta, escríbenos citando el radicado {radicado}.\n\nCordialmente,\n{empresa}',
  },
  {
    key: 'ampliacion',
    label: 'Ampliación del plazo',
    text: 'Hola, {nombre}:\n\nSobre tu solicitud {radicado} del {fecha}: no nos es posible responderte dentro del plazo inicial porque [COMPLETAR: la razón]. Te daremos respuesta a más tardar el {plazo}.\n\nCordialmente,\n{empresa}',
  },
  {
    key: 'informacion',
    label: 'Pedir información que falta',
    text: 'Hola, {nombre}:\n\nPara atender tu solicitud {radicado} necesitamos que nos envíes [COMPLETAR: qué falta y para qué]. Cuando la recibamos, continuaremos con el trámite.\n\nCordialmente,\n{empresa}',
  },
  {
    key: 'traslado',
    label: 'No nos corresponde (traslado)',
    text: 'Hola, {nombre}:\n\nRevisamos tu solicitud {radicado} del {fecha} y el asunto no le corresponde a {empresa} sino a [COMPLETAR: quién]. [COMPLETAR: si la remitimos nosotros o cómo puedes contactarlos].\n\nCordialmente,\n{empresa}',
  },
  {
    key: 'felicitacion',
    label: 'Agradecer una felicitación',
    text: 'Hola, {nombre}:\n\nGracias por tomarte el tiempo de escribirnos (radicado {radicado}). Compartimos tu mensaje con el equipo.\n\nCordialmente,\n{empresa}',
  },
];

export function fillResponse(
  template: string,
  values: {
    nombre: string;
    radicado: string;
    fecha: string;
    empresa: string;
    asunto: string;
    plazo: string;
  },
): string {
  return template.replace(
    /\{(nombre|radicado|fecha|empresa|asunto|plazo)\}/g,
    (_m, k: keyof typeof values) => values[k],
  );
}
