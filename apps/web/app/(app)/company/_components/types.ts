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
