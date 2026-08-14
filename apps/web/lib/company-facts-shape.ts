/**
 * LA COPIA DEL NAVEGADOR DEL MEDIDOR DE LA FICHA.
 *
 * Existe por lo mismo que `goals-shape.ts`, `approvals-shape.ts` y
 * `commitments-shape.ts`: importar un VALOR de `@cortex/agent-tools` desde un
 * componente `'use client'` arrastra `node:dns` al bundle y rompe el build de
 * producción mientras el typecheck y las pruebas siguen en verde. Los TIPOS sí
 * viajan —se borran al compilar—, así que aquí sólo se copia lo que es dato.
 *
 * Y SE COPIA LO MÍNIMO, QUE AQUÍ SON CUATRO NÚMEROS Y UNA SUMA. El catálogo de
 * secciones —los nombres, las descripciones, los campos sugeridos— NO se copia:
 * es dato serializable, así que la página de servidor lo baja como props y hay
 * una sola lista en todo el producto. Lo único que no se puede bajar por props
 * es una función, y la función es la que tiene que correr mientras alguien
 * teclea: el medidor se mueve con cada letra o no sirve para nada.
 *
 * Por eso `weighCompanyFactsHere` recibe los nombres de las secciones en vez de
 * conocerlos. Sin ese argumento habría que copiar el catálogo, y un catálogo
 * copiado envejece; un argumento no.
 *
 * `lib/company-facts-parity.test.ts` importa las dos copias en Node y falla en
 * cuanto discrepan. Sin esa prueba esto no sería una copia, sería un segundo
 * presupuesto — y el que se ve en pantalla le ganaría al que de verdad manda.
 */

/** Espeja COMPANY_FACTS_BUDGET. Ver el argumento del número en el canónico. */
export const COMPANY_FACTS_BUDGET = 4000;

/** Espeja COMPANY_FACT_LABEL_MAX. Es el `maxLength` del campo del nombre. */
export const COMPANY_FACT_LABEL_MAX = 60;

/** Espeja COMPANY_FACT_VALUE_MAX. Es el `maxLength` del campo del dato. */
export const COMPANY_FACT_VALUE_MAX = 300;

/** Espeja COMPANY_FACTS_MAX. Cuántos hechos caben en la ficha. */
export const COMPANY_FACTS_MAX = 120;

/** Un hecho, con lo justo para pesarlo. */
export interface WeighableFact {
  section: string;
  label: string;
  value: string;
}

/** Lo que un hecho le cuesta al bloque, formato incluido. */
export function weighCompanyFactHere(fact: WeighableFact): number {
  return `- ${fact.label.trim()}: ${fact.value.trim()}\n`.length;
}

/**
 * Cuánto del presupuesto se llevan estos hechos, calculado en el navegador.
 *
 * `sectionNames` es el mapa slug → nombre que baja la página de servidor. Un
 * slug que no esté en el mapa se pesa por el slug, igual que hace el canónico:
 * un medidor que se olvida de lo que no reconoce miente por lo bajo.
 */
export function weighCompanyFactsHere(
  facts: WeighableFact[],
  sectionNames: Record<string, string>,
): number {
  const sections = new Set<string>();
  let total = 0;
  for (const fact of facts) {
    total += weighCompanyFactHere(fact);
    sections.add(fact.section);
  }
  for (const key of sections) total += `\n## ${sectionNames[key] ?? key}\n`.length;
  return total;
}
