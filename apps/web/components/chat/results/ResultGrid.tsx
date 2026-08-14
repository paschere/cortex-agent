'use client';

import {
  type GridColumn,
  type GridRow,
  type GridSort,
  VISIBLE_ROWS,
  columnTotals,
  dig,
  formatAmount,
  formatDate,
  isHttpUrl,
  isNumericColumn,
  rowCountLabel,
  rowKey,
  shortUrl,
  sortOrder,
} from '@/lib/result-grid';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * UNA SOLA REJILLA, Y POR QUÉ HABÍA DOS.
 *
 * ===========================================================================
 * EL PROBLEMA
 * ===========================================================================
 * `DeclaredTable` y `StructuralResult` pintaban el mismo dato de dos maneras.
 * No por desacuerdo: por copia. Una tenía el relleno a `px-4`, la otra a `px-2`;
 * una alineaba las cifras por columna, la otra celda a celda; una avisaba de que
 * había cortado a cincuenta filas, la otra no cortaba y podía soltar
 * trescientas en una burbuja de chat. Ninguna de esas diferencias la decidió
 * nadie, y el repositorio ya documenta en `lib/panels/registry.tsx` a dónde
 * lleva eso: «dos versiones divergen — no si alguien se descuida, sino en cuanto
 * una de las dos se arregla».
 *
 * Así que la diferencia entre las dos capas vuelve a ser la única que siempre
 * fue de verdad: la AUTORIDAD sobre las columnas. La declarada sabe cuáles son,
 * cómo se llaman y qué significan porque alguien lo escribió; la estructural las
 * dedujo de la forma. Cómo se dibujan es la misma pregunta y ahora tiene una
 * sola respuesta.
 *
 * ===========================================================================
 * QUÉ SE TOMÓ DE LA REFERENCIA Y QUÉ NO
 * ===========================================================================
 * De `RecordsTable` entran los comportamientos, nunca los estilos —sus clases
 * `records-*` y su `var(--green)` no existen aquí; los tokens son `emerald`,
 * `amber`, `rose` y viven en `tailwind.config.ts`:
 *
 *   PRIMERA COLUMNA PEGAJOSA. Es LA respuesta al móvil. Seis columnas en una
 *   pantalla de 360px no caben, y hasta hoy se apretaban hasta dos caracteres
 *   por línea. Ahora la tabla se desplaza y la primera columna —la que dice de
 *   QUÉ es cada fila— se queda quieta. El filo sólo se dibuja cuando de verdad
 *   hay algo desplazado debajo.
 *
 *   ORDENACIÓN POR COLUMNA, con indicador y `aria-sort`. Tres estados: sube,
 *   baja, y vuelve al orden en que lo devolvió la herramienta —que suele ser el
 *   orden que ella considera relevante y que no debería costar recargar. Ordena
 *   TODAS las filas y no las cincuenta visibles; el porqué está en
 *   `lib/result-grid.ts`.
 *
 *   ENLACES DE VERDAD. Una celda con una URL era texto que había que
 *   seleccionar y copiar. Sólo `http` y `https`, y con icono de salida porque se
 *   abre fuera.
 *
 *   PIE CON EL CONTEO Y LOS TOTALES. «7 filas · Importe 12.400.000 COP». Las
 *   cuatro condiciones que tiene que cumplir un total para escribirse están en
 *   `columnTotals`, y la primera es que alguien haya dicho que esa columna es
 *   dinero.
 *
 *   EL DESPLAZAMIENTO ES ALCANZABLE CON TECLADO. `tabIndex` y `aria-label`: una
 *   región que sólo se puede mover con un ratón es contenido que no existe para
 *   quien no lo usa.
 *
 * Y lo que NO entra:
 *
 *   LAS CASILLAS DE SELECCIÓN. Seleccionar filas sirve para HACER algo con
 *   ellas, y aquí no hay ninguna acción a la que llevarlas: esto es la respuesta
 *   a una pregunta dentro de una conversación, no la pantalla de un CRM. Una
 *   casilla que no lleva a ninguna parte promete una acción que no existe, y eso
 *   es peor que no tener casilla. El día que una tabla de resultado tenga algo
 *   que hacer con varias filas a la vez, la casilla llega con la acción.
 *
 *   LAS LÍNEAS VERTICALES DE REJILLA. Regla 2 del sistema de diseño: la
 *   profundidad la da la luz, y las hairlines son para definir un borde, nunca
 *   para separar. «Una pantalla definida sólo por líneas se lee como una hoja de
 *   cálculo», que es literalmente lo que este producto sustituye. La única
 *   vertical que hay es la del filo de la columna pegajosa, y sólo mientras haya
 *   algo pasando por debajo.
 *
 *   LA PALETA DE DOCE COLORES DE ETIQUETA. Aquí el color significa: `emerald` es
 *   en vigor, `amber` por vencer, `rose` vencido. Pintar «Bogotá» de rosa porque
 *   le tocó por orden alfabético es escribir «vencido» sobre una ciudad.
 */

/** A partir de cuántas filas ordenar significa algo. Dos filas se ven enteras. */
const SORTABLE_FROM = 3;

export function ResultGrid({
  columns,
  rows,
  density = 'card',
  label,
}: {
  columns: readonly GridColumn[];
  /** TODAS las filas. El corte a cincuenta lo hace esto, después de ordenar. */
  rows: readonly GridRow[];
  /** `card` es la salida del turno; `inline` vive dentro del paso desplegado. */
  density?: 'card' | 'inline';
  /** Qué es esta tabla, para quien la oye en vez de verla. */
  label?: string;
}) {
  const [sort, setSort] = useState<GridSort | null>(null);
  const [shifted, setShifted] = useState(false);

  const sortable = rows.length >= SORTABLE_FROM;
  const order = useMemo(() => sortOrder(rows, sortable ? sort : null), [rows, sort, sortable]);
  const shown = order.slice(0, VISIBLE_ROWS);
  const totals = useMemo(() => columnTotals(rows, columns), [rows, columns]);
  // Alineación por COLUMNA, no por celda: una columna de importes con tres
  // huecos no puede alinearse de dos maneras según la fila.
  const numeric = useMemo(
    () =>
      columns.map((c) => c.kind === 'number' || c.kind === 'money' || isNumericColumn(rows, c.key)),
    [columns, rows],
  );

  const pad = density === 'card' ? 'px-4 py-2' : 'px-2 py-1.5';
  const footer = totals.length > 0 || rows.length > VISIBLE_ROWS || rows.length >= SORTABLE_FROM;

  function toggle(key: string) {
    setSort((current) => {
      if (current?.key !== key) return { key, dir: 'asc' };
      // Tercer clic: se vuelve al orden de la herramienta. Un orden que no se
      // puede deshacer obliga a recargar la conversación para recuperarlo.
      return current.dir === 'asc' ? { key, dir: 'desc' } : null;
    });
  }

  return (
    <div className="space-y-1.5">
      <div
        className="scroll-slim overflow-x-auto"
        // `group` y no `region`: un landmark por cada resultado de herramienta
        // convierte el índice de un lector de pantalla en una lista de treinta
        // entradas iguales.
        // biome-ignore lint/a11y/useSemanticElements: es lo mismo que ya argumenta `QuickChips` — `role="group"` con nombre describe exactamente esto, y `<fieldset>` es de un formulario. Aquí no se rellena nada.
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: es al revés de lo que dice la regla. Una caja que se desplaza y NO está en el orden de tabulación sólo se puede mover con un ratón, y las columnas que quedan fuera del borde dejan de existir para quien no usa uno. Es el patrón que la propia WAI pide para una región con scroll, y es la mitad de la respuesta al móvil que trae este componente.
        tabIndex={0}
        aria-label={
          label ?? `Tabla de ${rows.length} filas y ${columns.length} columnas, se desplaza de lado`
        }
        onScroll={(e) => setShifted(e.currentTarget.scrollLeft > 0)}
      >
        <table
          className="w-full border-collapse text-xs"
          // Sin un ancho mínimo, seis columnas en un teléfono no se desplazan:
          // se APRIETAN, y una celda de dos caracteres por línea no es una
          // tabla. Con él, por debajo de este ancho la tabla se mueve de lado y
          // la primera columna se queda: siempre se sabe de qué es la fila que
          // se está leyendo.
          style={{ minWidth: `${columns.length * 6}rem` }}
        >
          <thead>
            <tr className="border-b border-border">
              {columns.map((column, i) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort?.key === column.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={clsx(
                    'whitespace-nowrap text-micro font-semibold uppercase tracking-field text-ink-faint',
                    pad,
                    numeric[i] ? 'text-right' : 'text-left',
                    i === 0 && stickyCell(shifted),
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(column.key)}
                      className={clsx(
                        'group inline-flex max-w-full items-center gap-1 rounded-sm uppercase transition-colors duration-150 hover:text-ink motion-reduce:transition-none',
                        numeric[i] && 'flex-row-reverse',
                      )}
                    >
                      <span className="truncate">{column.label}</span>
                      <SortMark dir={sort?.key === column.key ? sort.dir : null} />
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((index) => {
              const row = rows[index] as GridRow;
              return (
                <tr key={rowKey(row, index)} className="border-b border-border/60 last:border-0">
                  {columns.map((column, i) => (
                    <td
                      key={column.key}
                      className={clsx(
                        'align-top text-ink',
                        pad,
                        numeric[i] && 'tabular text-right',
                        i === 0 && stickyCell(shifted),
                      )}
                    >
                      <Cell value={dig(row, column.key)} kind={column.kind} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {footer && (
        // NUNCA CORTAR EN SILENCIO: ver cincuenta filas y creer que son todas es
        // peor que ver cincuenta y saber que hay más. Y el total, cuando lo hay,
        // es de las que dice el conteo — no de las que se ven.
        <p className={clsx('text-micro text-ink-faint', density === 'card' ? 'px-4 pb-2' : 'px-2')}>
          {rowCountLabel(rows.length, VISIBLE_ROWS)}
          {totals.map((total) => (
            <span key={total.key}>
              {' · '}
              {total.label}{' '}
              <span className="tabular text-ink-muted">
                {formatAmount(total.value)}
                {total.currency ? ` ${total.currency}` : ''}
              </span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * La primera columna, quieta mientras el resto se mueve.
 *
 * Necesita fondo opaco o el texto de las demás columnas le pasa por debajo. Los
 * tres sitios donde se monta esta rejilla —la tarjeta del chat, el paso
 * desplegado de `TaskRows` y el panel de `PanelHost`— están sobre `surface`.
 *
 * El borde está SIEMPRE, transparente hasta que hay algo desplazado: pintarlo
 * sólo al desplazar movería la tabla un píxel justo cuando alguien la está
 * arrastrando.
 */
function stickyCell(shifted: boolean): string {
  return clsx(
    'sticky left-0 z-10 border-r bg-surface transition-colors duration-150 motion-reduce:transition-none',
    shifted ? 'border-border' : 'border-transparent',
  );
}

/** El indicador: el de la columna activa siempre; el resto, al apuntarla. */
function SortMark({ dir }: { dir: 'asc' | 'desc' | null }) {
  if (dir === 'asc') return <ArrowUp className="h-3 w-3 shrink-0 text-primary" aria-hidden />;
  if (dir === 'desc') return <ArrowDown className="h-3 w-3 shrink-0 text-primary" aria-hidden />;
  return (
    <ArrowUpDown
      className="h-3 w-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-60 motion-reduce:transition-none"
      aria-hidden
    />
  );
}

/**
 * Una celda.
 *
 * Lo único que se toca es lo que alguien DECLARÓ, y sólo cuando el valor viene
 * en crudo: un importe que es un número se agrupa por miles —`12400000` son
 * ocho dígitos que hay que contar con el dedo—, y una fecha que es una cadena
 * ISO se escribe como se dice. Nada se convierte: ni de moneda, ni de escala, ni
 * de zona horaria. El porqué de cada raya está en `lib/result-grid.ts`.
 *
 * Lo que llega como cadena se pinta tal cual, siempre. Si la herramienta ya
 * escribió «$1.200.000», eso es lo que quería que se leyera, y encima de un
 * formato ya puesto no se escribe otro.
 *
 * Y la capa estructural no adivina nada: sin `kind` no hay ni agrupado ni
 * fechas. Una cadena que parece una fecha puede ser una versión o un
 * identificador, y convertir `2026-09-14` en «14 sep 2026» en una columna que
 * era otra cosa es perder el dato para siempre.
 */
function Cell({ value, kind }: { value: unknown; kind?: GridColumn['kind'] }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-ink-faint">—</span>;
  }
  if (typeof value === 'boolean') return <>{value ? 'Sí' : 'No'}</>;
  if (typeof value === 'number' && kind === 'money') return <>{formatAmount(value)}</>;
  if (typeof value === 'string') {
    if (kind === 'date') return <span className="tabular">{formatDate(value)}</span>;
    if (isHttpUrl(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer noopener"
          title={value}
          className="inline-flex items-center gap-1 text-primary transition-colors duration-150 hover:text-primary-strong hover:underline motion-reduce:transition-none"
        >
          <span className="break-all">{shortUrl(value)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      );
    }
  }
  return <>{String(value)}</>;
}
