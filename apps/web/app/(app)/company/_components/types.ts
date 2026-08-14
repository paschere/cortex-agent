/**
 * Formas planas entre la página de servidor y el tablero de cliente.
 *
 * Nada de aquí puede importar `@cortex/agent-tools`. Un componente `'use client'`
 * que arrastre ese paquete se lleva `node:dns` al bundle del navegador y rompe
 * el build de producción, mientras el typecheck y las pruebas siguen en verde —
 * así se envió una vez ya. Ver `apps/web/lib/company-facts-shape.ts`.
 *
 * Por eso el CATÁLOGO DE SECCIONES baja por props en vez de copiarse: es dato
 * serializable, así que la lista canónica sigue siendo una sola en todo el
 * producto. Lo único que no puede bajar por props es una función, y la única que
 * hace falta a este lado —la del medidor— tiene su copia y su prueba de paridad.
 */

import type { Proposal } from '../_lib/proposal';

/** Un hecho, tal como se pinta y se edita. */
export interface FactView {
  id: string;
  section: string;
  label: string;
  value: string;
  /** Quién lo dejó escrito. Null cuando esa persona ya no está en el espacio. */
  updatedByName: string | null;
  /** Sólo la fecha: la hora no le dice nada a nadie sobre un dato permanente. */
  updatedOn: string;
}

/** Una sección de la ficha, con sus campos sugeridos. Baja tal cual del registro. */
export interface SectionView {
  key: string;
  name: string;
  blurb: string;
  suggested: string[];
}

/** El resultado de una acción de servidor, dicho en español. */
export interface ActionResult {
  ok: boolean;
  note?: string;
  error?: string;
}

/**
 * Lo que devuelve «Que lo busque Cortex».
 *
 * `Proposal` viaja entero al navegador y NO se guarda en ninguna parte. Eso es
 * la decisión: una propuesta es un borrador que vive lo que dura la pantalla
 * abierta, no una fila con estado que alguien tendría que ir a limpiar. Si se
 * pierde, se vuelve a pulsar el botón.
 *
 * Y sobre todo: no existe ninguna ruta por la que un valor propuesto llegue a
 * `company_facts` sin pasar por `saveFact`, que es la misma acción que usa el
 * formulario de a mano y la que comprueba el rol y el presupuesto. Cortex
 * propone; escribir sigue siendo de una persona.
 */
export interface ProposeResult {
  ok: boolean;
  proposal?: Proposal;
  /** Lo que no se pudo mirar, para no confundir «no hay» con «no se pudo». */
  notes?: string[];
  error?: string;
}
