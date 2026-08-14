/**
 * LO QUE UNA TABLA DE RESULTADO SABE HACER, SIN REACT DELANTE.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO VIVE DENTRO DEL COMPONENTE
 * ===========================================================================
 * Ordenar y totalizar son las dos cosas de una tabla que pueden MENTIR. Un
 * orden mal calculado enseña el segundo importe más grande como si fuera el
 * mayor; un total mal sumado es una cifra que alguien va a copiar a un correo.
 * Las dos se comprueban aquí, en `result-grid.test.ts`, porque el entorno de
 * pruebas de esta app es `node` y no monta componentes: si esta lógica viviera
 * en el `.tsx` no habría manera de probarla, y lo que no se prueba es
 * exactamente lo que se rompe en silencio.
 *
 * El componente (`components/chat/results/ResultGrid.tsx`) se queda con lo que
 * sí es suyo: pintar, y decidir qué está pegajoso y qué se desplaza.
 *
 * ===========================================================================
 * LA REGLA QUE ATRAVIESA TODO EL ARCHIVO
 * ===========================================================================
 * ANTE LA DUDA, NO SE CALCULA. Es la misma doctrina que ya rige `registry.tsx`
 * («se rinde antes que adivinar»): una columna que no se sabe qué es no se
 * totaliza, un valor que no se sabe leer no se ordena por magnitud, y una
 * unidad que nadie declaró no se inventa. Una tabla sin total es una tabla; una
 * tabla con un total inventado es un error de contabilidad con tipografía
 * bonita.
 */

/** Lo que una columna dice de sí misma. `money` es lo único que se totaliza. */
export type GridKind = 'text' | 'number' | 'date' | 'money';

export interface GridColumn {
  /** Campo de cada fila. Admite `a.b` para bajar un nivel. */
  key: string;
  label: string;
  kind?: GridKind;
}

export type GridRow = Record<string, unknown>;

export interface GridSort {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * Cuántas filas se pintan.
 *
 * El corte estaba en `structuralView`, que recortaba a cincuenta ANTES de que
 * nadie pudiera ordenar. Eso convertía «ordenar por importe» en «ordenar las
 * primeras cincuenta por importe», que enseña el máximo de una muestra como si
 * fuera el máximo — el fallo exacto que este archivo existe para no cometer.
 * Ahora la lista llega entera, se ordena entera, y el corte es lo último que
 * pasa. Y se dice en pantalla: nunca cortar en silencio.
 */
export const VISIBLE_ROWS = 50;

/** `a.b` baja un nivel. Nada más: una ruta de tres saltos es un dato mal puesto. */
export function dig(row: GridRow, key: string): unknown {
  if (!key.includes('.')) return row[key];
  const [head, tail] = key.split('.', 2);
  const nested = row[head ?? ''];
  return nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>)[tail ?? '']
    : undefined;
}

/** Un hueco. Los tres se pintan como una raya y los tres se ordenan al final. */
function missing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * ¿Esta columna son cifras?
 *
 * Se mira la COLUMNA entera y no cada celda. Mirar celda a celda —que es lo que
 * hacía la capa estructural— alinea a la derecha las filas que traen número y a
 * la izquierda las que traen hueco, y una columna de importes con tres valores
 * descolgados no se lee como una columna.
 */
export function isNumericColumn(rows: readonly GridRow[], key: string): boolean {
  let seen = 0;
  for (const row of rows) {
    const value = dig(row, key);
    if (missing(value)) continue;
    if (typeof value !== 'number') return false;
    seen++;
  }
  return seen > 0;
}

/**
 * EL ORDEN, COMO ÍNDICES Y NO COMO FILAS.
 *
 * Devuelve las posiciones originales en el orden en que hay que pintarlas. Es
 * lo que le da a cada fila una clave de React estable: si se devolvieran filas
 * reordenadas, la clave sería la posición nueva y React desmontaría media tabla
 * en cada clic sobre una cabecera.
 *
 * El criterio se decide UNA VEZ por columna, no por pareja de celdas: si todo
 * lo que hay son números, se ordena por magnitud; si son booleanos, `No` antes
 * que `Sí`; y si no, texto en español. Decidirlo por pareja es cómo una columna
 * mixta acaba con un orden que no es ninguno de los dos.
 *
 * Y NO se intenta leer «$1.200.000» como un número. Un analizador de moneda
 * formateada acierta con el peso colombiano y falla con `1,200.00`, y un orden
 * equivocado es tan mentira como un total equivocado — sólo que más difícil de
 * ver. Las herramientas de este repositorio devuelven `amount: z.number()`, así
 * que el camino que importa ya está cubierto sin adivinar nada.
 *
 * Los huecos van al final SIEMPRE, suba o baje el orden: una raya no es «lo más
 * pequeño», es «no se sabe», y no debe ganarle el primer puesto a un dato real.
 */
export function sortOrder(rows: readonly GridRow[], sort: GridSort | null): number[] {
  const order = rows.map((_, i) => i);
  if (!sort) return order;

  const values = rows.map((row) => dig(row, sort.key));
  const present = values.filter((v) => !missing(v));
  if (present.length === 0) return order;

  const compare = comparator(present);
  const flip = sort.dir === 'desc' ? -1 : 1;

  // `sort` es estable en todos los motores desde 2019: los empates conservan el
  // orden en que la herramienta los devolvió, que suele ser el orden que ella
  // considera relevante.
  return order.sort((a, b) => {
    const left = values[a];
    const right = values[b];
    const leftGone = missing(left);
    const rightGone = missing(right);
    if (leftGone || rightGone) return leftGone && rightGone ? 0 : leftGone ? 1 : -1;
    return flip * compare(left, right);
  });
}

function comparator(present: readonly unknown[]): (a: unknown, b: unknown) => number {
  if (present.every((v) => typeof v === 'number')) {
    return (a, b) => (a as number) - (b as number);
  }
  if (present.every((v) => typeof v === 'boolean')) {
    return (a, b) => Number(a as boolean) - Number(b as boolean);
  }
  // `numeric` deja «Fila 2» delante de «Fila 10», y de paso ordena bien las
  // fechas ISO, que ya son crecientes como texto.
  const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  return (a, b) => collator.compare(String(a), String(b));
}

export interface GridTotal {
  key: string;
  label: string;
  value: number;
  /** El código que traían las filas, si traían uno solo. Nunca uno inventado. */
  currency: string | null;
}

/** Campos que dicen en qué moneda está la cifra de al lado. */
const CURRENCY_KEYS = new Set(['currency', 'moneda']);

/**
 * Qué monedas hay en juego. `mixed` es la que manda: con dos monedas distintas
 * no hay ningún total honesto que se pueda escribir, ni siquiera sin símbolo.
 */
function currencies(rows: readonly GridRow[]): { code: string | null; mixed: boolean } {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!CURRENCY_KEYS.has(key.toLowerCase())) continue;
      if (typeof value === 'string' && value.trim()) seen.add(value.trim().toUpperCase());
    }
  }
  const [only] = [...seen];
  return { code: seen.size === 1 ? (only ?? null) : null, mixed: seen.size > 1 };
}

/**
 * LA FILA DE PIE, Y LAS CUATRO CONDICIONES QUE TIENE QUE CUMPLIR.
 *
 * «7 filas · $12.4M en total» al pie de una cartera es lo que alguien va a
 * querer. Pero un total es una AFIRMACIÓN, y esta app no afirma lo que no sabe:
 *
 *   1. LA COLUMNA TIENE QUE SER DINERO Y HABERLO DICHO. `kind: 'money'` lo
 *      escribió en `registry.tsx` alguien que conoce esa herramienta. Una
 *      columna que sólo es «numérica» no se totaliza: la suma de `Prioridad`,
 *      de `Avance` o de `Empleados` es una cifra que nadie pidió y que parece
 *      un dato. Por eso la capa estructural —que no sabe qué es ninguna de sus
 *      columnas— nunca totaliza nada, y es correcto que no lo haga.
 *   2. TODAS LAS FILAS TIENEN UN NÚMERO DE VERDAD. Ni una raya, ni una cadena
 *      ya formateada. Un total al que le faltan tres filas no es un total
 *      parcial: es un total equivocado, porque nadie lo va a leer como parcial.
 *   3. UNA SOLA MONEDA. Sumar pesos con dólares es la manera más cara de
 *      equivocarse, y `payments.list` trae la columna `currency` al lado
 *      justamente porque puede haber más de una.
 *   4. AL MENOS DOS FILAS. El «total» de una fila es esa fila otra vez.
 *
 * Y se suma sobre TODAS las filas recibidas, no sobre las cincuenta que se
 * pintan. El pie dice cuántas hay, así que la cifra corresponde a lo que ahí
 * pone; totalizar sólo lo visible sería la misma mentira que ordenar sólo lo
 * visible.
 */
export function columnTotals(
  rows: readonly GridRow[],
  columns: readonly GridColumn[],
): GridTotal[] {
  if (rows.length < 2) return [];
  const money = columns.filter((c) => c.kind === 'money');
  if (money.length === 0) return [];

  const { code, mixed } = currencies(rows);
  if (mixed) return [];

  const totals: GridTotal[] = [];
  for (const column of money) {
    let sum = 0;
    let complete = true;
    for (const row of rows) {
      const value = dig(row, column.key);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        complete = false;
        break;
      }
      sum += value;
    }
    if (complete) totals.push({ key: column.key, label: column.label, value: sum, currency: code });
  }
  return totals;
}

/**
 * UN IMPORTE, AGRUPADO A LA COLOMBIANA. Y DÓNDE ESTÁ LA RAYA.
 *
 * `payments.list` devuelve `amount: 12400000` — un número pelado. Pintarlo tal
 * cual son ocho dígitos seguidos que nadie lee sin contarlos con el dedo, y
 * dejaba además la tabla diciendo `12400000` en la celda y `12.400.000` en el
 * total, que es la clase de detalle que hace dudar de las dos cifras.
 *
 * Agrupar los miles NO es reformatear el dato: no cambia el valor ni la unidad,
 * es la convención con la que se lee un número en Colombia. Lo que sigue
 * prohibido es lo otro, y por eso esto sólo se aplica en dos sitios:
 *
 *   SÓLO A `money`, Y SÓLO SI ES UN NÚMERO DE VERDAD. Una cadena ya la formateó
 *   la herramienta, con su símbolo y su moneda, y encima de eso no se escribe.
 *   Y `number` se queda crudo a propósito: `github.list_pull_requests` declara
 *   la columna `number` como numérica, y el pull request 1200 no es «1.200».
 *
 *   NUNCA SE CONVIERTE. Ni de moneda ni de escala. Un total en dólares que se
 *   pinta como pesos es el fallo caro, y no lo evita no formatear: lo evita no
 *   tocar el valor, que es lo que pasa aquí.
 *
 * Al total tampoco se le pone símbolo: el código de moneda, si sale, lo
 * trajeron las filas.
 */
export function formatAmount(value: number): string {
  try {
    return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(value);
  } catch {
    return String(value);
  }
}

/** «7 filas», o la verdad completa cuando no caben todas. */
export function rowCountLabel(total: number, shown: number): string {
  if (total <= shown) return total === 1 ? '1 fila' : `${total} filas`;
  return `${total} filas, se muestran ${shown}`;
}

/**
 * ¿Esto es un enlace de verdad?
 *
 * Sólo `http` y `https`. `javascript:` es una URL válida para `new URL` y un
 * agujero para quien pinte a ciegas lo que devolvió una herramienta que leyó
 * una página web, y aquí se pinta exactamente eso.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const URL_MAX = 44;

/**
 * La URL como se lee, no como se escribe.
 *
 * Se le quita el esquema y el `www.` —ruido en todas— y si sigue sin caber se
 * parte por el MEDIO: el final de una URL es donde está el número del pull
 * request o el id del documento, o sea la parte que dice cuál es. Cortar por el
 * final deja cincuenta enlaces que se leen igual. El texto completo queda en el
 * `title` y en el `href`, que es lo que se abre.
 */
export function shortUrl(value: string): string {
  const bare = value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
  if (bare.length <= URL_MAX) return bare;
  return `${bare.slice(0, 26)}…${bare.slice(-16)}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Una fecha, legible, SIN convertir nunca un día de calendario en un instante.
 *
 * `2026-09-14` se formatea desde la cadena y jamás a través de un `Date`:
 * parsearlo y volver a formatearlo es cómo un vencimiento del 14 aparece como
 * el 13 para cualquiera cuyo navegador esté al oeste de Bogotá. Es la misma
 * regla que ya escribieron `commitments/_components/format.ts` y
 * `payments/_components/format.ts`, y la razón de que las columnas `date` no se
 * puedan resolver con un `toLocaleDateString` y ya.
 *
 * Un instante completo sí es un instante, y se lee en la hora de Bogotá. Lo que
 * no se parsea, se devuelve tal cual: una fecha que el formateador no entiende
 * se enseña como vino, nunca como «Invalid Date».
 *
 * El nombre del mes sale SIEMPRE de la lista de arriba, también en la rama del
 * instante. `Intl` en español abrevia septiembre como «sept», así que pedirle a
 * él el mes ponía «14 sep 2026» y «14 sept 2026» en dos columnas de la misma
 * tabla según una fuera un día y la otra una marca de tiempo. A `Intl` se le
 * pide lo único que sólo él sabe: qué día es en Bogotá.
 */
export function formatDate(iso: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (day) return `${Number(day[3])} ${MONTHS[Number(day[2]) - 1] ?? day[2]} ${day[1]}`;

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    const parts = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const month = MONTHS[Number(get('month')) - 1];
    if (!month) return iso.slice(0, 10);
    return `${Number(get('day'))} ${month} ${get('year')}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** La clave de React de una fila: un id de verdad, o su posición original. */
export function rowKey(row: GridRow, index: number): string {
  const id = row.id ?? row.slug ?? row.key ?? row.uuid;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : `row-${index}`;
}
