import type { PersonRecord, PersonTally } from '../_components/types';

/**
 * Cómo se dice en voz alta lo que la vista por persona ya calculó.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN ARCHIVO Y NO TRES `template strings` EN EL COMPONENTE
 * ===========================================================================
 * Esta pantalla dice quién no cumplió. La diferencia entre una herramienta que
 * un gerente abre todos los lunes y una que abre una vez y nunca más está
 * ENTERA en la redacción, así que la redacción se prueba como se prueba un
 * cálculo. «Ana: 8 de 9 a tiempo» y «Ana: falló 1 de 9» salen del mismo dato y
 * no son la misma frase.
 *
 * Las tres reglas, y las tres tienen prueba:
 *
 *   1. SE CUENTA LO CUMPLIDO, NUNCA LO FALLADO. Siempre «8 de 9 a tiempo»,
 *      jamás «1 tarde». El dato es idéntico; el segundo convierte una lista de
 *      trabajo en un expediente.
 *   2. NINGUNA PERSONA SE PINTA DE ROJO. El rojo de este producto significa
 *      «esto se venció» y va sobre la cosa vencida, que es un hecho con fecha.
 *      Sobre un nombre significaría otra cosa, y no es cosa que una pantalla
 *      deba decir de nadie. Por eso `recordTone` no puede devolver `rose`.
 *   3. CON POCO HISTORIAL NO SE DA CIFRA. Ver `PersonRecord.rate`.
 *
 * Sin `import` de `@cortex/agent-tools` a propósito: de aquí come un componente
 * `'use client'`, y ese barril arrastra `node:dns` hasta romper el build de
 * producción — el mismo muro que documenta `lib/commitments-shape.ts`.
 */

/** Cumple casi siempre: se puede decir con tranquilidad. */
export const GOOD_RATE = 0.8;

/** Por debajo de esto la cifra ya no es ruido, y vale la pena preguntar qué pasa. */
export const WEAK_RATE = 0.5;

/**
 * El color de un historial. Nunca `rose` — ver la regla 2 arriba.
 *
 * `amber` no quiere decir «esta persona es un problema»: quiere decir «aquí hay
 * algo que preguntar», que es lo mismo que dice el ámbar en el resto del
 * producto.
 */
export function recordTone(record: PersonRecord): 'emerald' | 'amber' | 'neutral' {
  if (record.rate === null) return 'neutral';
  if (record.rate >= GOOD_RATE) return 'emerald';
  if (record.rate < WEAK_RATE) return 'amber';
  return 'neutral';
}

/**
 * «8 de 9 a tiempo», o la verdad cuando todavía no hay con qué.
 *
 * Devuelve `null` cuando la persona no ha cerrado nada en la ventana: un chip
 * que dijera «0 de 0» ocuparía sitio para no decir nada.
 */
export function recordPhrase(record: PersonRecord): string | null {
  if (record.closed === 0) return null;
  if (record.rate === null) {
    return record.closed === 1
      ? 'cerró 1, todavía es pronto para una cifra'
      : `cerró ${record.closed}, todavía es pronto para una cifra`;
  }
  return `${record.onTime} de ${record.closed} a tiempo`;
}

/** El porcentaje, ya redondeado, o `null` si no se debe decir. */
export function ratePercent(record: PersonRecord): number | null {
  return record.rate === null ? null : Math.round(record.rate * 100);
}

/**
 * Las dos cuentas de una persona, cada una en sus propias palabras.
 *
 * `promise` y `paper` están separados hasta en el género de los adjetivos —
 * una promesa se ATRASA (la debe una persona y todavía se puede cumplir), un
 * papel se VENCE (la fecha pasó y ya no hay nada que hacer con ese papel). Que
 * suenen distinto es parte de que no se sumen.
 */
export function tallyPhrase(tally: PersonTally, of: 'promise' | 'paper'): string | null {
  if (tally.open === 0) return null;
  const noun =
    of === 'promise'
      ? tally.open === 1
        ? '1 promesa'
        : `${tally.open} promesas`
      : tally.open === 1
        ? '1 vencimiento a su nombre'
        : `${tally.open} vencimientos a su nombre`;
  if (tally.overdue === 0) return noun;
  const late =
    of === 'promise'
      ? tally.overdue === 1
        ? '1 atrasada'
        : `${tally.overdue} atrasadas`
      : tally.overdue === 1
        ? '1 vencido'
        : `${tally.overdue} vencidos`;
  return `${noun}, ${late}`;
}

/**
 * La invitación que va debajo del nombre: qué hacer con lo que se acaba de leer.
 *
 * Es un imperativo suave y en segunda persona, y eso es deliberado: la frase
 * que sigue a un atraso decide si la pantalla se lee como «a quién regaño» o
 * como «a quién le pregunto». No hay una sola versión que hable de la persona
 * en tercera persona, porque hablar de alguien es el tono del expediente.
 */
export function nudge(promises: PersonTally, papers: PersonTally): string {
  if (promises.overdue > 0) {
    return promises.overdue === 1
      ? 'La fecha pasó y sigue abierta. Suele bastar con preguntar qué la frenó.'
      : 'Varias pasaron de fecha. Vale la pena preguntar si es carga o si algo las está bloqueando.';
  }
  if (papers.overdue > 0) {
    return 'Hay papeles vencidos a su nombre. Puede que ni siquiera sepa que quedaron ahí.';
  }
  if (promises.open > 0) return 'Todo dentro de fecha por ahora.';
  return 'Sólo papeles, y ninguno vencido.';
}

/** «hace 3 días» y «en 12 días», pero para el resumen de una persona. */
export function urgencyPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'es hoy';
  if (daysLeft === 1) return 'es mañana';
  if (daysLeft === -1) return 'era ayer';
  if (daysLeft > 0) return `en ${daysLeft} días`;
  return `hace ${-daysLeft} días`;
}
