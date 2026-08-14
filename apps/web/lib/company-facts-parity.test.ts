import {
  COMPANY_FACTS_BUDGET,
  COMPANY_FACTS_MAX,
  COMPANY_FACT_LABEL_MAX,
  COMPANY_FACT_VALUE_MAX,
  type WeighableFact,
  weighCompanyFactHere,
  weighCompanyFactsHere,
} from '@/lib/company-facts-shape';
import * as tools from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * Los dos medidores de la ficha de la empresa, comparados en Node.
 *
 * El del paquete es el que MANDA: lo lee `writeCompanyFact` para rechazar un
 * dato que no cabe. El del navegador es el que SE VE: se mueve mientras alguien
 * teclea. Ninguno de los dos se puede borrar —el de servidor no puede correr en
 * un `onChange` sin arrastrar `node:dns` al bundle— así que lo que se prueba es
 * que no se separen.
 *
 * Si se separaran, el fallo sería de los caros: el medidor en pantalla diría que
 * quedan cuatrocientos caracteres, la persona escribiría un dato de trescientos,
 * y el guardado lo rechazaría por una cuenta que ella no puede ver. Dos veces, y
 * deja de usar la pantalla.
 *
 * Se comparan los CUATRO números y, sobre todo, EL RESULTADO de la suma en una
 * tabla de casos — que es lo que de verdad puede divergir, porque la aritmética
 * incluye el formato de la línea y el encabezado de cada sección.
 */

const names = Object.fromEntries(tools.COMPANY_SECTIONS.map((s) => [s.key, s.name]));

const CASES: Array<{ name: string; facts: WeighableFact[] }> = [
  { name: 'la ficha vacía', facts: [] },
  {
    name: 'un hecho suelto',
    facts: [{ section: 'identidad', label: 'NIT', value: '901.234.567-8' }],
  },
  {
    name: 'dos hechos de la misma sección, que comparten encabezado',
    facts: [
      { section: 'identidad', label: 'NIT', value: '901.234.567-8' },
      { section: 'identidad', label: 'Razón social', value: 'Transportes del Norte SAS' },
    ],
  },
  {
    name: 'hechos repartidos por las cinco secciones',
    facts: tools.COMPANY_SECTIONS.map((s) => ({
      section: s.key,
      label: s.suggested[0] ?? 'Dato',
      value: 'lo que sea, con tildes: ñoño áéíóú',
    })),
  },
  {
    name: 'con espacios de sobra a los lados',
    facts: [{ section: 'ingresos', label: '  Plazo de pago  ', value: '  a 30 días  ' }],
  },
  {
    name: 'una sección que no está en el registro',
    facts: [{ section: 'inventada', label: 'Algo', value: 'lo que sea' }],
  },
];

describe('el medidor de la ficha pesa igual en los dos lados', () => {
  it('tiene el mismo presupuesto', () => {
    expect(COMPANY_FACTS_BUDGET).toBe(tools.COMPANY_FACTS_BUDGET);
  });

  it('tiene los mismos topes por campo y por número de hechos', () => {
    expect(COMPANY_FACT_LABEL_MAX).toBe(tools.COMPANY_FACT_LABEL_MAX);
    expect(COMPANY_FACT_VALUE_MAX).toBe(tools.COMPANY_FACT_VALUE_MAX);
    expect(COMPANY_FACTS_MAX).toBe(tools.COMPANY_FACTS_MAX);
  });

  it.each(CASES)('pesa igual: $name', ({ facts }) => {
    expect(weighCompanyFactsHere(facts, names)).toBe(tools.weighCompanyFacts(facts));
  });

  it('pesa igual una línea suelta', () => {
    const fact = { section: 'identidad', label: 'NIT', value: '901.234.567-8' };
    expect(weighCompanyFactHere(fact)).toBe(tools.weighCompanyFact(fact));
  });
});
