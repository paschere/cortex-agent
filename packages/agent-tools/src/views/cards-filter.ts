/**
 * LOS FILTROS RÁPIDOS DE LA LISTA DE TARJETAS, EN PURO CÓDIGO.
 *
 * El cálculo entrega las tarjetas con lo necesario para filtrar (su día, su
 * estado, si son «mías», su grupo y los valores de orden); el navegador filtra
 * ahí mismo, sin pedir nada. Vive aparte del componente para probarse sin
 * React, y sólo importa tipos: el cliente lo carga sin el barril del paquete.
 */

export interface CardFilterable {
  title: string;
  subtitle: string | null;
  status: { label: string } | null;
  data: Array<{ value: string }>;
  day: string | null;
  mine: boolean;
  group: string | null;
  sort: Array<string | number | null>;
}

export interface CardFilterState {
  status: string | null;
  /** `today` o `week`: son excluyentes, como «hoy» y «esta semana». */
  when: 'today' | 'week' | null;
  mine: boolean;
  query: string;
}

export const EMPTY_CARD_FILTER: CardFilterState = {
  status: null,
  when: null,
  mine: false,
  query: '',
};

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function filterCards<T extends CardFilterable>(
  cards: T[],
  state: CardFilterState,
  range: { today: string; weekFrom: string; weekTo: string },
): T[] {
  const q = fold(state.query.trim());
  return cards.filter((c) => {
    if (state.status && c.status?.label !== state.status) return false;
    if (state.mine && !c.mine) return false;
    if (state.when === 'today' && c.day !== range.today) return false;
    if (state.when === 'week' && !(c.day && c.day >= range.weekFrom && c.day <= range.weekTo))
      return false;
    if (q) {
      const hay = fold(
        [c.title, c.subtitle ?? '', c.status?.label ?? '', ...c.data.map((d) => d.value)].join(' '),
      );
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Ordena por una de las llaves de orden que el cálculo entregó (índice en `sort`). */
export function sortCards<T extends CardFilterable>(
  cards: T[],
  by: { index: number; dir: 'asc' | 'desc' } | null,
): T[] {
  if (!by) return cards;
  const dir = by.dir === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => {
    const va = a.sort[by.index];
    const vb = b.sort[by.index];
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'es');
    return cmp * dir;
  });
}

/** Agrupa conservando el orden: la primera aparición de cada grupo manda. */
export function groupCards<T extends CardFilterable>(
  cards: T[],
): Array<{ group: string | null; cards: T[] }> {
  const out: Array<{ group: string | null; cards: T[] }> = [];
  const at = new Map<string | null, number>();
  for (const c of cards) {
    const key = c.group;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push({ group: key, cards: [c] });
    } else out[i]?.cards.push(c);
  }
  return out;
}

/** Las tarjetas de la página `page` (de 1), con `size` por página. */
export function pageOf<T>(cards: T[], page: number, size: number): { shown: T[]; more: number } {
  const end = Math.max(1, page) * size;
  return { shown: cards.slice(0, end), more: Math.max(0, cards.length - end) };
}
