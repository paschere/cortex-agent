import { type HelpArticle, articleRoutes, isArticleVisible } from './article';

/**
 * BUSCAR EN LA AYUDA SIN EMBEDDINGS.
 *
 * Son ~25 artículos escritos por nosotros: un BM25 en memoria con campos
 * pesados alcanza y sobra, no cuesta una llamada a nadie y da lo mismo hoy que
 * mañana (las pruebas fijan el orden). Lo que sí importa en español:
 *
 *   · sin tildes y en minúsculas en los dos lados («conexión» = «conexion»);
 *   · la eñe se queda («año» no es «ano»);
 *   · sin palabras vacías («cómo», «de», «la»...): «¿cómo conecto Siigo?»
 *     tiene que pesar por «conecto» y «siigo», no por «cómo»;
 *   · una raíz barata para plurales y conjugaciones comunes («facturas» →
 *     «factur», «conecto»/«conectar» → «conect»).
 *
 * Los campos pesan distinto: el título y las palabras clave dicen de qué trata
 * el artículo; el cuerpo sólo lo menciona. Un artículo que nombra «Siigo» en su
 * título gana sobre otro que lo nombra de pasada.
 */

/** Minúsculas, sin tildes ni diéresis; la eñe intacta. */
export function foldText(text: string): string {
  // NFD separa cada tilde en una marca combinante (U+0300–U+036F) que se borra.
  // La eñe también se separa («n» + U+0303): se recompone antes de borrar.
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/n\u0303/g, 'ñ')
    .replace(/\p{M}/gu, '');
}

const STOPWORDS = new Set(
  [
    'a',
    'al',
    'algo',
    'como',
    'con',
    'cual',
    'cuando',
    'de',
    'del',
    'donde',
    'el',
    'ella',
    'en',
    'es',
    'esta',
    'este',
    'esto',
    'hay',
    'hago',
    'hacer',
    'la',
    'las',
    'le',
    'les',
    'lo',
    'los',
    'me',
    'mi',
    'mis',
    'muy',
    'no',
    'o',
    'para',
    'pero',
    'por',
    'puedo',
    'que',
    'quiero',
    'se',
    'si',
    'sin',
    'sobre',
    'su',
    'sus',
    'te',
    'tu',
    'tus',
    'un',
    'una',
    'uno',
    'y',
    'ya',
    'yo',
    'cortex',
    'the',
    'how',
    'do',
    'i',
    'to',
  ].map(foldText),
);

const SUFFIXES = [
  'aciones',
  'iciones',
  'amientos',
  'imientos',
  'acion',
  'icion',
  'amiento',
  'imiento',
  'ando',
  'iendo',
  'ados',
  'idos',
  'adas',
  'idas',
  'ado',
  'ido',
  'ada',
  'ida',
  'ar',
  'er',
  'ir',
  'es',
  'as',
  'os',
  'a',
  'o',
  'e',
  's',
];

/** Raíz barata: quita una terminación común si deja al menos 4 letras. */
export function stem(word: string): string {
  if (word.length <= 4 || /\d/.test(word)) return word;
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Palabras con significado, dobladas y con raíz. */
export function tokenize(text: string): string[] {
  const words = foldText(text).match(/[a-zñ0-9]+/g) ?? [];
  return words.filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem);
}

const FIELD_WEIGHT = { title: 4, keywords: 3, summary: 2, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

interface IndexedDoc {
  article: HelpArticle;
  /** Frecuencia pesada de cada término (la suma de campos por su peso). */
  tf: Map<string, number>;
  length: number;
}

export interface HelpIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLength: number;
}

function fieldText(article: HelpArticle, field: Field): string {
  if (field === 'keywords') return article.keywords.join(' ');
  return article[field];
}

/** Índice BM25 de los artículos. Puro; se arma una vez por proceso. */
export function buildHelpIndex(articles: readonly HelpArticle[]): HelpIndex {
  const df = new Map<string, number>();
  const docs = articles.map((article) => {
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of Object.keys(FIELD_WEIGHT) as Field[]) {
      const weight = FIELD_WEIGHT[field];
      for (const token of tokenize(fieldText(article, field))) {
        tf.set(token, (tf.get(token) ?? 0) + weight);
        length += weight;
      }
    }
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return { article, tf, length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLength };
}

export interface HelpHit {
  article: HelpArticle;
  score: number;
}

/** Un resultado por debajo de esta fracción del mejor no se muestra. */
const RELATIVE_FLOOR = 0.3;

const K1 = 1.2;
const B = 0.6;

/** Tolerancia a erratas cortas: «sigo» encuentra «siigo». */
function nearTerms(index: HelpIndex, term: string): string[] {
  if (index.df.has(term) || term.length < 4) return [term];
  const near: string[] = [];
  for (const known of index.df.keys()) {
    if (Math.abs(known.length - term.length) > 1) continue;
    if (known[0] !== term[0]) continue;
    if (editDistanceAtMostOne(known, term)) near.push(known);
  }
  return near.length > 0 ? near : [term];
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export interface SearchOptions {
  limit?: number;
  /** Módulos encendidos de la empresa; los artículos de un módulo apagado no salen. */
  enabled?: ReadonlySet<string>;
}

/** Los artículos que mejor contestan la consulta, mejor primero. */
export function searchHelp(
  index: HelpIndex,
  query: string,
  options: SearchOptions = {},
): HelpHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const n = index.docs.length;
  const expanded = terms.map((term) => nearTerms(index, term));
  const hits: HelpHit[] = [];
  for (const doc of index.docs) {
    if (!isArticleVisible(doc.article, options.enabled)) continue;
    let score = 0;
    let matched = 0;
    for (const variants of expanded) {
      let best = 0;
      for (const term of variants) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = index.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = f + K1 * (1 - B + (B * doc.length) / index.avgLength);
        best = Math.max(best, (idf * (f * (K1 + 1))) / norm);
      }
      if (best > 0) matched++;
      score += best;
    }
    if (score <= 0) continue;
    // Cubrir más palabras de la consulta pesa más que repetir una sola.
    score *= 0.5 + (0.5 * matched) / terms.length;
    hits.push({ article: doc.article, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.article.order - b.article.order ||
      a.article.slug.localeCompare(b.article.slug),
  );
  // La cola larga de menciones de pasada no ayuda: fuera lo que no llega a una
  // fracción del mejor resultado.
  const floor = (hits[0]?.score ?? 0) * RELATIVE_FLOOR;
  return hits.filter((h) => h.score >= floor).slice(0, options.limit ?? 5);
}

/** Qué tan bien casa una ruta del artículo con la pantalla abierta (0 = nada). */
export function routeMatchLength(path: string, route: string): number {
  const clean = path.split(/[?#]/)[0]?.replace(/\/+$/, '') || '/';
  if (route === '/') return clean === '/' ? 1 : 0;
  if (clean === route || clean.startsWith(`${route}/`)) return route.length;
  return 0;
}

/**
 * Los artículos de la pantalla abierta, el más específico primero.
 *
 * Gana la ruta más larga que casa (`/integrations/whatsapp` antes que
 * `/integrations`); a igual largo, el artículo cuya pantalla PRINCIPAL es ésta
 * va antes que el que sólo la menciona.
 */
export function articlesForRoute(
  articles: readonly HelpArticle[],
  path: string,
  options: SearchOptions = {},
): HelpArticle[] {
  const scored: Array<{ article: HelpArticle; length: number; main: boolean }> = [];
  for (const article of articles) {
    if (!isArticleVisible(article, options.enabled)) continue;
    let best = 0;
    let main = false;
    for (const route of articleRoutes(article)) {
      const length = routeMatchLength(path, route);
      if (length > best || (length === best && length > 0 && route === article.route)) {
        best = length;
        main = route === article.route;
      }
    }
    if (best > 0) scored.push({ article, length: best, main });
  }
  scored.sort(
    (a, b) =>
      b.length - a.length ||
      Number(b.main) - Number(a.main) ||
      a.article.order - b.article.order ||
      a.article.slug.localeCompare(b.article.slug),
  );
  return scored.slice(0, options.limit ?? 6).map((s) => s.article);
}

/**
 * El pedazo del artículo que mejor contesta la consulta: el párrafo o la
 * entrada de lista con más palabras de la consulta. Para la herramienta del
 * chat y para los resultados de /ayuda.
 */
export function bestExcerpt(article: HelpArticle, query: string, max = 320): string {
  const terms = new Set(tokenize(query));
  const blocks = article.body
    .split(/\n{2,}|\n(?=\d+\.\s|[-*]\s)/)
    .map((b) => b.trim())
    // Ni encabezados ni filas que son sólo un enlace (las de «Relacionado»).
    .filter((b) => b && !b.startsWith('#') && !/^(?:[-*]\s+)?\[[^\]]+\]\([^)]+\)$/.test(b));
  let best = '';
  let bestScore = 0;
  for (const block of blocks) {
    const tokens = tokenize(block);
    const score = tokens.filter((t) => terms.has(t)).length;
    if (score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  const text = plainText(best || article.summary);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Markdown a texto llano, para extractos. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
