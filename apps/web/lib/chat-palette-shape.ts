/**
 * LOS DOS MENÚS DEL COMPOSITOR: `/` Y `@`, EN UN SOLO VOCABULARIO.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. `browser-shape.ts`,
 * `errands-shape.ts` and `commitments-shape.ts` all hit the same wall and solved
 * it the same way, and InputBar.tsx is a client component, so the wire shape and
 * the filtering both live here rather than next to the routes that build them.
 *
 * ===========================================================================
 * EL REPARTO: `/` ES QUÉ HACER, `@` ES DE QUÉ HABLAR
 * ===========================================================================
 * `/`  cosas que se EJECUTAN: rutinas, flujos, trámites, encargos y las
 *      herramientas del catálogo. Termina en un verbo.
 * `@`  cosas que se MENCIONAN: clientes, personas, documentos, espacios de
 *      memoria y placas. Termina en un nombre propio.
 *
 * Un menú de una sola lista tenía que elegir entre las dos y elegía mal: el
 * `@` ofrecía tres clases de cosa y el `/` nueve frases fijas, así que todo lo
 * demás que el producto sabe hacer sólo existía para quien ya lo sabía.
 *
 * ===========================================================================
 * LOS DOS SIGUEN EXPANDIÉNDOSE A TEXTO PLANO
 * ===========================================================================
 * Esto no cambia y es la parte que importa: `@Coltrans` se convierte en el
 * nombre del cliente y `/vencimientos` en una frase. Ninguno de los dos cuelga
 * un parámetro escondido de la petición, así que una pregunta compuesta con los
 * menús y la misma pregunta tecleada a mano producen turnos idénticos byte a
 * byte. Un comando es una frase que alguien habría tenido que escribir; una
 * mención es un nombre que habría tenido que deletrear. Nada más.
 *
 * En particular, elegir una herramienta en el `/` NO la fija para el turno: lo
 * único que hace es escribir en el compositor la frase en español con la que
 * uno la pediría. El rankeador sigue eligiendo las herramientas del turno a
 * partir de la pregunta, que es lo que está medido.
 */

import { MODULE } from './browser-shape';

/** Una fila del menú. `expands` es lo que aterriza en el compositor. */
export interface PaletteItem {
  /** Estable dentro de su grupo; sólo sirve para el `key` de React. */
  id: string;
  label: string;
  /** Una línea de contexto debajo. Puede faltar. */
  hint: string | null;
  /**
   * El texto que reemplaza lo tecleado. Un espacio al final significa «sigue
   * escribiendo aquí».
   */
  expands: string;
  /** Palabras extra que el filtro debe emparejar y que no se muestran. */
  keywords?: string;
  /** El `/comando` se dibuja en monoespaciada; un nombre propio no. */
  mono?: boolean;
}

export interface PaletteGroup {
  id: string;
  /** Encabezado de la sección, en español. */
  heading: string;
  /** Nombre de un icono de lucide; el cliente lo resuelve a un componente. */
  icon: string;
  items: PaletteItem[];
  /**
   * Por qué esta sección viene vacía. Una consulta que falla NUNCA se dibuja
   * como una lista vacía: «no hay rutinas» y «no pude leer las rutinas» son
   * respuestas distintas y sólo una de las dos es cierta.
   */
  error?: string;
  /** Cuántas filas se ocultaron por el tope de la vista sin filtro. */
  more?: number;
}

export interface PaletteResponse {
  groups: PaletteGroup[];
}

/** Mínimo de letras antes de buscar una mención. Una sola casa con todo. */
export const MENTION_MIN_CHARS = 2;

/** Cuántas filas por grupo se ven antes de teclear nada. */
export const PALETTE_PREVIEW_CAP = 6;

// ---------------------------------------------------------------------------
// Los comandos fijos: preguntas que no salen de ninguna tabla
// ---------------------------------------------------------------------------

/**
 * Los nueve de siempre, intactos. Son las preguntas del día a día y siguen
 * primeras porque son las que alguien teclea sin pensar; lo que se agrega
 * debajo es todo lo demás, no un reemplazo de esto.
 */
export const STATIC_COMMAND_GROUP: PaletteGroup = {
  id: 'comandos',
  heading: 'Lo de todos los días',
  icon: 'Terminal',
  items: [
    {
      id: '/vencimientos',
      label: '/vencimientos',
      hint: 'Qué se vence y cuándo',
      expands: '¿Qué documentos y compromisos se vencen en los próximos 30 días?',
      keywords: 'vence plazos soat poliza contrato compromisos',
      mono: true,
    },
    {
      id: '/placa',
      label: '/placa',
      hint: 'Consultar RUNT y SIMIT',
      expands: 'Consulta la placa ',
      keywords: 'vehiculo carro runt simit comparendo',
      mono: true,
    },
    {
      id: '/informe',
      label: '/informe',
      hint: 'Generar y guardar un informe',
      expands: 'Hazme el informe de vencimientos de este mes.',
      keywords: 'reporte pdf mensual',
      mono: true,
    },
    {
      id: '/grafica',
      label: '/grafica',
      hint: 'Dibujar lo que se acaba de calcular',
      expands: 'Gráfica ',
      keywords: 'grafico chart barras torta',
      mono: true,
    },
    {
      id: '/buscar',
      label: '/buscar',
      hint: 'Buscar en Brain Knowledge',
      expands: 'Busca en Brain Knowledge lo que tengamos sobre ',
      keywords: 'kb memoria conocimiento documentos',
      mono: true,
    },
    {
      id: '/rutina',
      label: '/rutina',
      hint: 'Programar algo que se repita',
      expands: 'Todos los lunes a las 8 de la mañana, ',
      keywords: 'programar cron horario repetir',
      mono: true,
    },
    {
      id: '/encargo',
      label: '/encargo',
      hint: 'Que investigue algo por su cuenta',
      expands: 'Investígame ',
      keywords: 'errand investigar largo autonomo',
      mono: true,
    },
    {
      id: '/tramite',
      label: '/tramite',
      hint: `Correr un ${MODULE.one} web ya aprendido`,
      expands: `Corre el ${MODULE.one} `,
      keywords: 'portal navegador certificado radicar',
      mono: true,
    },
    {
      id: '/briefing',
      label: '/briefing',
      hint: 'Qué te espera hoy',
      expands: '¿Qué está esperando algo de mí?',
      keywords: 'colas vencimientos aprobaciones briefing hubspot',
      mono: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Lo que se está tecleando en el cursor
// ---------------------------------------------------------------------------

/**
 * Hasta dónde puede crecer la consulta del `/` antes de que dejemos de creer
 * que es un comando. Sin tope, alguien que empieza un mensaje largo con una
 * barra escribe un párrafo entero con el menú abierto y Enter seleccionando en
 * vez de enviar.
 */
const SLASH_MAX_QUERY = 48;

/** Lo tecleado después de la `/` inicial, o null si no hay comando en curso. */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const query = text.slice(1);
  if (query.includes('\n')) return null;
  if (query.length > SLASH_MAX_QUERY) return null;
  return query;
}

/** El `@palabra` que está en el cursor, si lo hay. */
export function mentionAtCaret(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Tiene que empezar palabra: `correo@empresa.com` es una dirección, no una
  // mención.
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

// ---------------------------------------------------------------------------
// Filtrado y agrupado
// ---------------------------------------------------------------------------

/**
 * Sin tildes y en minúsculas. Nadie escribe «trámite» con tilde dentro de un
 * menú que se está filtrando a toda velocidad, y un filtro que se la exige es
 * un filtro que no encuentra el trámite.
 */
export function fold(value: string): string {
  // La eñe se parte a mano y se vuelve a pegar. `NFD` la descompone en «n» +
  // tilde y el paso siguiente se lleva la tilde, así que sin este rodeo «año»
  // y «ano» serían la misma palabra. Es una letra del alfabeto, no una vocal
  // acentuada: nadie la teclea sin querer y nadie espera que se la perdonen.
  return value
    .toLowerCase()
    .split('ñ')
    .map((part) =>
      part
        .normalize('NFD')
        // biome-ignore lint/suspicious/noMisleadingCharacterClass: el rango ES de marcas combinantes y borrarlas es justo el objetivo — «á» ya se separó en «a» + marca dos líneas antes.
        .replace(/[\u0300-\u036f]/g, ''),
    )
    .join('ñ');
}

function haystack(item: PaletteItem): string {
  return fold(`${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`);
}

/** Todas las palabras de la consulta tienen que aparecer. */
export function matchesQuery(item: PaletteItem, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack(item);
  return terms.every((term) => hay.includes(term));
}

/**
 * Filtra y recorta, conservando el orden de los grupos.
 *
 * Dos reglas que valen la pena decir en voz alta:
 *
 *  - Un grupo con `error` SIEMPRE sobrevive, aunque no tenga filas. Es la
 *    diferencia entre «no tienes rutinas» y «no pude leer tus rutinas», y
 *    dibujar la segunda como la primera es mentirle a alguien sobre su propio
 *    espacio de trabajo.
 *  - Sin consulta, cada grupo muestra un tope de filas y cuenta el resto. Un
 *    menú que se abre con doscientas filas es un menú que nadie lee; teclear
 *    dos letras las trae todas.
 */
export function filterPalette(
  groups: PaletteGroup[],
  query: string,
  previewCap = PALETTE_PREVIEW_CAP,
): PaletteGroup[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const out: PaletteGroup[] = [];

  for (const group of groups) {
    // GitHub y Linear son oficio de ingeniería. En reposo no aparecen: un
    // gerente colombiano no abre el `/` a ver repositorios. Teclear «github»
    // o «linear» los trae, que es cómo se descubren sin ocupar el martes.
    if (terms.length === 0 && group.id === 'tools:eng') continue;
    const matched = group.items.filter((item) => matchesQuery(item, terms));
    if (matched.length === 0) {
      if (group.error) out.push({ ...group, items: [], more: undefined });
      continue;
    }
    // El tope es sólo para la vista de reposo: en cuanto hay consulta, se ve
    // todo lo que empareja o el filtro estaría mintiendo sobre lo que hay.
    const capped = terms.length === 0 ? matched.slice(0, previewCap) : matched;
    out.push({
      ...group,
      items: capped,
      more: matched.length > capped.length ? matched.length - capped.length : undefined,
    });
  }

  return out;
}

/** Las filas seleccionables, en el orden en que se ven. Para las flechas. */
export function flattenPalette(
  groups: PaletteGroup[],
): Array<{ groupId: string; item: PaletteItem }> {
  const flat: Array<{ groupId: string; item: PaletteItem }> = [];
  for (const group of groups) {
    for (const item of group.items) flat.push({ groupId: group.id, item });
  }
  return flat;
}

/** Cuántas filas seleccionables hay. */
export function paletteSize(groups: PaletteGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}
