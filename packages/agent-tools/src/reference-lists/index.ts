import { AIRLINES } from './airlines';
import { AIRPORTS } from './airports';
import { COLOMBIAN_BANKS, CURRENCIES } from './banks-currencies';

/**
 * LISTAS DE REFERENCIA DE LA PLATAFORMA.
 *
 * Equivalencias fijas (código de aerolínea → nombre, IATA → ciudad, banco →
 * código) mantenidas en el repo. Cualquier campo con `match` las usa como
 * fuente `cortex.<lista>` sin llamar a ningún modelo; también se leen como
 * tabla de sólo lectura en una vista. Sin dependencias: las puede importar el
 * navegador.
 */

export interface ReferenceColumn {
  key: string;
  label: string;
}

export interface ReferenceList {
  /** `cortex.aerolineas`. */
  id: string;
  name: string;
  description: string;
  /** La columna que se busca (el código). */
  keyColumn: string;
  columns: ReferenceColumn[];
  rows: Array<Record<string, string>>;
  /**
   * `trm`: las filas no están en el repo; salen de la base (migración 0241) y la
   * clave se busca por FECHA dentro de la vigencia (`range`), no por igualdad.
   */
  dynamic?: 'trm';
  range?: { from: string; to: string };
}

const list = (
  id: string,
  name: string,
  description: string,
  columns: ReferenceColumn[],
  tuples: ReadonlyArray<readonly string[]>,
): ReferenceList => ({
  id: `cortex.${id}`,
  name,
  description,
  keyColumn: columns[0]?.key ?? 'codigo',
  columns,
  rows: tuples.map((t) => Object.fromEntries(columns.map((c, i) => [c.key, t[i] ?? '']))),
});

export const REFERENCE_LISTS: ReadonlyMap<string, ReferenceList> = new Map(
  [
    list(
      'aerolineas',
      'Aerolíneas (código IATA)',
      'Código IATA de 2 caracteres, nombre comercial y país.',
      [
        { key: 'codigo', label: 'Código IATA' },
        { key: 'nombre', label: 'Aerolínea' },
        { key: 'pais', label: 'País' },
      ],
      AIRLINES,
    ),
    list(
      'aeropuertos',
      'Aeropuertos (código IATA)',
      'Aeropuertos principales: código IATA de 3 letras, nombre, ciudad y país.',
      [
        { key: 'codigo', label: 'Código IATA' },
        { key: 'nombre', label: 'Aeropuerto' },
        { key: 'ciudad', label: 'Ciudad' },
        { key: 'pais', label: 'País' },
      ],
      AIRPORTS,
    ),
    list(
      'bancos_colombia',
      'Bancos de Colombia',
      'Código de entidad, nombre y tipo de los bancos y billeteras de Colombia.',
      [
        { key: 'codigo', label: 'Código' },
        { key: 'nombre', label: 'Banco' },
        { key: 'tipo', label: 'Tipo' },
      ],
      COLOMBIAN_BANKS,
    ),
    list(
      'monedas',
      'Monedas (ISO 4217)',
      'Código ISO de 3 letras, nombre y símbolo.',
      [
        { key: 'codigo', label: 'Código ISO' },
        { key: 'nombre', label: 'Moneda' },
        { key: 'simbolo', label: 'Símbolo' },
      ],
      CURRENCIES,
    ),
    {
      ...list(
        'trm',
        'TRM oficial (pesos por dólar)',
        'Tasa Representativa del Mercado de la Superfinanciera (datos.gov.co): el valor rige desde vigencia_desde hasta vigencia_hasta, fines de semana y festivos incluidos. Se busca por FECHA (p. ej. de traslado) y se actualiza sola cada día.',
        [
          { key: 'vigencia_desde', label: 'Rige desde' },
          { key: 'vigencia_hasta', label: 'Rige hasta' },
          { key: 'valor', label: 'Pesos por dólar' },
        ],
        [],
      ),
      dynamic: 'trm' as const,
      range: { from: 'vigencia_desde', to: 'vigencia_hasta' },
    },
  ].map((l) => [l.id, l]),
);

export function referenceList(id: string): ReferenceList | null {
  return REFERENCE_LISTS.get(id) ?? null;
}

export const isReferenceListId = (id: string) => REFERENCE_LISTS.has(id);

/** Para la descripción de las herramientas. */
export function referenceListsGrammar(): string {
  return [...REFERENCE_LISTS.values()]
    .map(
      (l) =>
        `${l.id} (${l.name}; clave ${l.keyColumn}; columnas ${l.columns.map((c) => c.key).join(', ')})`,
    )
    .join('; ');
}
