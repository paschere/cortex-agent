'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

/**
 * QUÉ SE DIBUJA CUANDO UNA HERRAMIENTA CONTESTA.
 *
 * ===========================================================================
 * EL PROBLEMA QUE ESTE ARCHIVO EXISTE PARA CERRAR
 * ===========================================================================
 * De ~134 herramientas registradas, CUATRO tenían vista propia. Las otras 130
 * salían como una fila gris con el JSON plegado detrás de un chevron.
 *
 * Eso no es un defecto estético, es la razón por la que la gente se va del
 * chat. `actions.list` existe desde hace meses y está en el menú `/` con la
 * frase «Muéstrame las acciones que esperan mi aprobación». Alguien la escribe,
 * recibe una fila gris, y se va a `/actions`. No fue porque no supiera dónde
 * estaba la pantalla: preguntó y no le contestaron.
 *
 * ===========================================================================
 * TRES CAPAS, Y LA DE ABAJO NO NECESITA QUE NADIE LA ALIMENTE
 * ===========================================================================
 * No se pueden escribir 130 vistas, y no hay que escribirlas. Una vista a
 * medida para `github.get_repo_contents` sería un visor de código que nadie
 * pidió. Lo que sube es el SUELO, no el techo:
 *
 *   RICH        ~15 entradas. Una vista propia para lo que una persona
 *               necesita mirar y sobre lo que va a actuar. Card.
 *   TABLE       ~30 entradas de DATOS PUROS, sin JSX: qué campo trae las
 *               filas y qué columnas enseñar. Añadir una son 60 segundos.
 *   estructural CERO entradas. Mira la forma del resultado en tiempo de
 *               ejecución y decide. Cubre de golpe gmail, outlook, linear,
 *               github, hubspot, vehicles, payroll — unas 80 herramientas.
 *
 * La doctrina no es nueva en este repositorio: `lib/tool-args.ts` ya la
 * argumenta para las filas de paso — «una regla que funciona para todas gana a
 * una frase que funciona para doce y degrada en silencio».
 *
 * ===========================================================================
 * DÓNDE APARECE CADA UNA, Y POR QUÉ NO TODAS SON TARJETA
 * ===========================================================================
 * `TaskRows` tiene razón en su tesis y no se toca: una llamada a herramienta es
 * un RENGLÓN, no un documento, y doce tarjetas son una pared. Así que:
 *
 *   RICH y TABLE  → tarjeta. Son la salida del turno.
 *   estructural   → DENTRO del chevron de TaskRows, en lugar del <pre> de JSON.
 *                   Un paso sigue siendo un paso; lo único que cambia es que al
 *                   desplegarlo se lee.
 *
 * Y los dos centinelas de sobre (`__requires_confirmation`, `__error`) ganan a
 * todo lo de aquí: son estado del turno, no identidad de la herramienta.
 *
 * ===========================================================================
 * POR QUÉ `next/dynamic` EN EL VALOR DEL MAPA
 * ===========================================================================
 * Quince renderizadores importados de forma estática entran en el bundle del
 * transcript aunque una conversación no use ninguno. Con `dynamic`, este
 * registro puede crecer a cuarenta entradas sin coste en la primera pintura.
 *
 * ===========================================================================
 * LA REGLA QUE NO SE PUEDE ROMPER: NADA DE VALORES DE @cortex/agent-tools
 * ===========================================================================
 * Este archivo es `'use client'`. Puede importar TIPOS del paquete —se borran
 * al compilar— y NUNCA un valor. Ese barril alcanza `node:dns`, y un valor
 * importado desde un componente de cliente compila en local, pasa el typecheck
 * y las pruebas, y rompe el build de producción. Ya pasó una vez; está contado
 * en `lib/reports-shape.ts`. `registry.test.ts` es el espejo que lo vigila.
 */

/** Lo que recibe cualquier renderizador. Nada más viaja hasta aquí. */
export interface ResultViewProps {
  result: unknown;
  /** Para una tarjeta que necesita saber a qué llamada pertenece. */
  toolCallId: string;
  /** Refrescar lo que la tarjeta cambió (aprobar, descartar). */
  onSettled?: () => void;
}

export type ResultView = ComponentType<ResultViewProps>;

/**
 * Un id de herramienta llega con dos grafías: el AI SDK la nombra con guiones
 * bajos y el registro la declaró con punto, y una conversación archivada puede
 * guardar cualquiera de las dos. Antes eso eran cuatro predicados dobles
 * escritos a mano; ahora se normaliza una vez, aquí.
 */
export function normalizeToolId(toolName: string): string {
  return toolName.replaceAll('.', '_');
}

// ---------------------------------------------------------------------------
// Capa 1 — vistas propias
// ---------------------------------------------------------------------------

/**
 * Las herramientas cuyo resultado es la RESPUESTA del turno, no un paso hacia
 * ella. El orden en que se cubren no es de gusto: primero las colas sobre las
 * que una persona actúa, porque son las que hacen que alguien se vaya del chat.
 *
 * `ssr: false` no hace falta: son componentes de cliente dentro de un árbol de
 * cliente. Lo que aporta `dynamic` aquí es el corte del bundle.
 */
export const RICH: Record<string, ResultView> = {
  // Ya existían como ramas escritas a mano; ahora son entradas.
  sales_draft_proposal: dynamic(() =>
    import('../ProposalCard').then((m) => m.ProposalCard as unknown as ResultView),
  ),
};

// ---------------------------------------------------------------------------
// Capa 2 — tablas declaradas
// ---------------------------------------------------------------------------

export interface TableColumn {
  /** Campo de cada fila. Admite `a.b` para bajar un nivel. */
  key: string;
  label: string;
  /** `number` alinea a la derecha y usa cifras tabulares. */
  kind?: 'text' | 'number' | 'date' | 'money';
}

export interface TableSpec {
  /** Campo del resultado que trae el array. */
  rows: string;
  columns: TableColumn[];
  /** Campo con la frase de contexto, si la hay. */
  note?: string;
  /** Qué decir cuando el array viene vacío. Nunca una tabla en blanco. */
  empty: string;
}

/**
 * SOLO DATOS. Ni JSX, ni funciones, ni condiciones.
 *
 * Es lo que hace que añadir una tabla cueste un minuto y no una revisión de
 * diseño, y lo que permite que la escriba quien conoce la herramienta en vez de
 * quien conoce React.
 */
export const TABLE: Record<string, TableSpec> = {};

// ---------------------------------------------------------------------------
// Capa 3 — la forma del resultado, sin que nadie la declare
// ---------------------------------------------------------------------------

export type Structural =
  | { kind: 'table'; rows: Record<string, unknown>[]; columns: string[]; note: string | null }
  | { kind: 'fields'; entries: Array<[string, unknown]>; note: string | null }
  | { kind: 'note'; text: string }
  | null;

/** Campos que son prosa sobre el resultado y no parte de él. */
const NOTE_KEYS = ['guidance', 'summary', 'note', 'message', 'markdown'];

/** Ruido de protocolo que nunca es contenido. */
const HIDDEN_KEYS = new Set(['__error', '__requires_confirmation', '_security', 'ok']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Un valor que cabe en una celda sin explicación. */
function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Qué se puede decir de este resultado sin saber de qué herramienta viene.
 *
 * Deliberadamente conservadora: ante la duda devuelve `null` y quien llama
 * enseña el JSON, que es lo que hacía antes. Adivinar mal la forma de un
 * resultado y dibujar una tabla que se come la mitad de los datos es peor que
 * el JSON, porque el JSON al menos se ve entero.
 */
export function structuralView(result: unknown): Structural {
  if (!isPlainObject(result)) return null;

  const note = NOTE_KEYS.map((k) => result[k]).find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );

  const entries = Object.entries(result).filter(([k]) => !HIDDEN_KEYS.has(k));
  const content = entries.filter(([k]) => !NOTE_KEYS.includes(k));

  // Un único campo array de objetos planos → tabla. Es la forma de
  // `{items: [...]}`, `{flows: [...]}`, `{threads: [...]}` y otras ochenta.
  const arrays = content.filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject),
  );
  if (arrays.length === 1 && arrays[0]) {
    const rows = arrays[0][1] as Record<string, unknown>[];
    // Columnas de la PRIMERA fila y solo escalares: un objeto anidado en una
    // celda es ilegible, y las filas siguientes que traigan campos de más se
    // quedan fuera a propósito — una tabla cuyas columnas cambian por la fila
    // catorce no es una tabla.
    const columns = Object.entries(rows[0] ?? {})
      .filter(([, v]) => isScalar(v))
      .map(([k]) => k)
      .slice(0, 6);
    if (columns.length > 0) {
      return { kind: 'table', rows: rows.slice(0, 50), columns, note: note ?? null };
    }
  }

  // Un objeto plano y corto → lista de campos.
  const scalars = content.filter(([, v]) => isScalar(v));
  if (scalars.length > 0 && scalars.length <= 8 && scalars.length === content.length) {
    return { kind: 'fields', entries: scalars, note: note ?? null };
  }

  // Solo una frase, sin datos que enseñar.
  if (note && content.length === 0) return { kind: 'note', text: note };

  return null;
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

export type Resolved =
  | { as: 'rich'; View: ResultView }
  | { as: 'table'; spec: TableSpec }
  | { as: 'step' };

/**
 * Cómo se dibuja el resultado de esta llamada.
 *
 * No mira el resultado: solo el id. Que un resultado concreto no sirva para su
 * vista —un gráfico sin id, unas marcas vacías— lo decide el propio
 * renderizador, que es quien sabe qué necesita. Aquí solo se elige el camino.
 */
export function resolveView(toolName: string): Resolved {
  const id = normalizeToolId(toolName);
  const View = RICH[id];
  if (View) return { as: 'rich', View };
  const spec = TABLE[id];
  if (spec) return { as: 'table', spec };
  return { as: 'step' };
}
