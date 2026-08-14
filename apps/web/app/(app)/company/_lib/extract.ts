import { InvalidNitError, nameKey, normalizeNit, parseNit } from '@cortex/agent-tools';

/**
 * SACAR LA IDENTIDAD DE UN TEXTO SIN PREGUNTARLE A UN MODELO.
 *
 * ===========================================================================
 * POR QUÉ UNA EXPRESIÓN REGULAR Y NO UNA LLAMADA
 * ===========================================================================
 * No es por ahorrar. Es porque UN VALOR PROPUESTO TIENE QUE SER LITERAL.
 *
 * El chip de procedencia dice «de tu contrato con Coltrans, marzo 2026», y eso
 * es una afirmación sobre de dónde salió el texto que hay al lado. Si el texto
 * lo redactó un modelo leyendo el contrato, el chip miente: la frase no está en
 * el contrato, se PARECE a lo que dice el contrato. Y la diferencia entre esas
 * dos cosas es exactamente lo que la persona no puede comprobar de un vistazo,
 * porque lo que ve es una frase razonable con un sello debajo.
 *
 * Así que todo lo que sale de aquí es una subcadena del documento, tal cual,
 * con el renglón donde estaba para poder cotejarla. Lo que no se puede sacar
 * literal —«a qué se dedica», resumido de nueve páginas— NO SE SACA. Ese es el
 * hueco, y el hueco es la respuesta correcta.
 *
 * ===========================================================================
 * LOS DOS FILTROS QUE HACEN QUE ESTO NO SEA UN GENERADOR DE NÚMEROS PLAUSIBLES
 * ===========================================================================
 *
 *   EL DÍGITO DE VERIFICACIÓN. Un NIT no es «diez dígitos»: es un número con
 *   una suma de comprobación, y `parseNit` ya la sabe hacer porque los clientes
 *   la necesitaban. Una cifra cualquiera de un PDF pasa esa comprobación una
 *   vez de cada once. Un teléfono, una factura y un consecutivo la fallan casi
 *   siempre, y cuando el DV viene escrito y no cuadra, es una afirmación FALSA
 *   y no un dato incompleto — se tira.
 *
 *   EL NOMBRE QUE TECLEÓ LA PERSONA, QUE ES EL ANCLA DE TODO ESTE ARCHIVO.
 *   Un contrato nombra a DOS empresas y trae DOS NIT, y nada en el texto dice
 *   cuál de las dos eres tú. Ésta es la forma más fácil que tiene esta pantalla
 *   de escribir el NIT del cliente en la ficha de la empresa y no enterarse
 *   nunca. Por eso el botón pide el nombre: no es una comodidad de búsqueda, es
 *   el desempate. Sólo se acepta la razón social que CASA con lo que la persona
 *   escribió, y sólo se acepta el NIT que está pegado a ella.
 *
 * Y hay un tercer filtro que no vive aquí y conviene saber que existe: el
 * recolector le pasa los NIT de todos sus clientes registrados en
 * `excludeNitDigits`, así que un NIT que ya se sabe de quién es no puede
 * proponerse como propio. Ver `gather.ts`.
 */

/** Un hallazgo, con el renglón que lo contiene para poder cotejarlo. */
export interface TextFinding {
  /** Literal, tal como está en el texto. */
  value: string;
  /** El renglón donde apareció, recortado. Es lo que se enseña bajo el chip. */
  quote: string;
  /** Dónde empieza en el texto. Sirve para medir cercanía entre hallazgos. */
  at: number;
}

/** Lo más largo que se cita. Un renglón, no un párrafo. */
const QUOTE_MAX = 180;

/**
 * El renglón que contiene `at`, recortado y sin espacios de sobra.
 *
 * Se recorta por el FINAL y no por el centro: lo que hace falta ver es lo que
 * rodea al dato por la izquierda («identificada con NIT»), que es lo que dice
 * de quién es.
 */
function lineAt(text: string, at: number): string {
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  const line = text
    .slice(start, end === -1 ? text.length : end)
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// El NIT
// ---------------------------------------------------------------------------

/**
 * «NIT», «N.I.T.», «Nit:». La palabra, escrita como la escribe la gente.
 *
 * Las dos guardas de los extremos no son adorno: sin la de la izquierda,
 * «monitoreo» contiene «nit» y sin la de la derecha, «nitrógeno» también. Las
 * dos dispararían una búsqueda de número catorce caracteres más allá, y de vez
 * en cuando encontrarían uno.
 */
const NIT_WORD = /\bn\.?\s?i\.?\s?t\.?(?![a-záéíóúñü])/gi;

/**
 * El número, en las dos formas en que se escribe un NIT en Colombia.
 *
 * `900.123.456-7` (agrupado) o `830025281-7` (seguido), con o sin el dígito de
 * verificación, y con espacios en vez de puntos si a quien lo escribió le dio
 * por ahí. La alternativa agrupada va PRIMERA porque una alternancia en una
 * expresión regular se prueba en orden: al revés, `\d{4,15}` se comería «900» y
 * dejaría el resto fuera.
 */
const NIT_NUMBER = /(\d{1,3}(?:[.\s]\d{3})+|\d{4,15})\s*(?:[-–—]\s*(\d))?/;

/**
 * Cuántos caracteres después de la palabra «NIT» se admite el número.
 *
 * Cabe «NIT No. », «NIT número: » y «N.I.T.:  », y no cabe la siguiente frase.
 * Un número que está a treinta caracteres de la palabra «NIT» probablemente no
 * es el NIT, y proponerlo saldría gratis hoy y caro durante meses.
 */
const NIT_GAP = 14;

/**
 * Todos los NIT del texto que además CUADRAN.
 *
 * «Que cuadran» es literal: se exige la palabra NIT delante y que el dígito de
 * verificación no contradiga a los dígitos. Un NIT escrito sin DV se acepta
 * —no afirma nada sobre el dígito— y se devuelve ya con el suyo calculado, que
 * es la forma en que se escribe y en que la gente lo reconoce.
 */
export function findNits(text: string): TextFinding[] {
  const found: TextFinding[] = [];
  const seen = new Set<string>();

  for (const word of text.matchAll(NIT_WORD)) {
    const from = (word.index ?? 0) + word[0].length;
    const window = text.slice(from, from + NIT_GAP + 24);
    const hit = window.match(NIT_NUMBER);
    if (!hit || hit.index === undefined || hit.index > NIT_GAP) continue;

    const raw = hit[2] ? `${hit[1]}-${hit[2]}` : (hit[1] as string);
    let formatted: string;
    let digits: string;
    try {
      const parsed = parseNit(raw);
      formatted = parsed.formatted;
      digits = parsed.digits;
    } catch (err) {
      // Un DV que no cuadra es una afirmación falsa, no un dato a medias. Se
      // tira sin ruido: la pantalla no tiene nada útil que decir sobre un
      // número que casi era un NIT.
      if (err instanceof InvalidNitError) continue;
      throw err;
    }

    // Un NIT que aparece nueve veces en un contrato es un NIT, no nueve. Se
    // conserva la PRIMERA aparición porque en un contrato es la del
    // encabezamiento, donde está el nombre al lado.
    if (seen.has(digits)) continue;
    seen.add(digits);

    const at = from + hit.index;
    found.push({ value: formatted, quote: lineAt(text, word.index ?? 0), at });
  }

  return found;
}

// ---------------------------------------------------------------------------
// La razón social
// ---------------------------------------------------------------------------

/**
 * Las formas societarias colombianas, escritas como se escriben de verdad.
 *
 * Con y sin puntos, con y sin espacios entre las iniciales, porque «S.A.S.»,
 * «S.A.S», «SAS» y «S. A. S.» son la misma sociedad y la que no esté en esta
 * lista es una razón social que no se propone.
 */
const LEGAL_SUFFIX =
  '(?:S\\.?\\s?A\\.?\\s?S\\.?\\s?B\\.?\\s?I\\.?\\s?C\\.?|S\\.?\\s?A\\.?\\s?S\\.?|S\\.?\\s?C\\.?\\s?A\\.?|S\\.?\\s?EN\\.?\\s?C\\.?(?:\\s?S\\.?)?|S\\.?\\s?A\\.?|LTDA\\.?|LIMITADA|E\\.?\\s?U\\.?|B\\.?\\s?I\\.?\\s?C\\.?)';

/**
 * El borde derecho de la forma societaria, y hace falta.
 *
 * Sin él, «Coltrans salud» casa con «Coltrans» + «S A», y la razón social
 * propuesta sería «Coltrans sa». Una forma societaria termina donde termina la
 * palabra: lo que sigue no puede ser una letra ni un número.
 */
const SUFFIX_END = '(?![a-z0-9])';

/**
 * Una copia del texto sin tildes y en minúscula, DE LA MISMA LONGITUD.
 *
 * Lo de la longitud es el punto entero. `normalize('NFD')` separa la tilde en
 * un carácter aparte y por tanto MUEVE todos los índices siguientes, así que un
 * hallazgo localizado sobre el texto normalizado se recortaría del original
 * desplazado unas cuantas letras — y el valor propuesto saldría mordido, con su
 * chip y todo. Aquí se dobla carácter a carácter y se conserva el original en
 * cuanto el plegado no da exactamente una letra, así que los índices de las dos
 * cadenas son el mismo índice.
 */
function foldSameLength(text: string): string {
  let out = '';
  for (const ch of text) {
    const folded = ch
      .normalize('NFD')
      // Sólo diacríticos combinantes (U+0300–U+036F), todos dentro del BMP.
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: rango sin pares subrogados
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase();
    out += folded.length === ch.length ? folded : ch.toLowerCase();
  }
  return out;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * LA RAZÓN SOCIAL DE ELLOS, ANCLADA EN EL NOMBRE QUE TECLEARON.
 *
 * Busca en el texto el nombre que escribió la persona SEGUIDO de una forma
 * societaria, y devuelve el trozo entero tal como está escrito allí.
 *
 * DEVUELVE NULL SI NO HAY FORMA SOCIETARIA, Y ESO NO ES UN FALLO: si en el
 * documento pone «Coltrans» a secas y la persona escribió «Coltrans», proponer
 * «Razón social: Coltrans» es devolverle lo que acaba de teclear con un sello
 * encima que dice que viene de un contrato. Lo que este campo aporta —y lo
 * único que aporta— es el «S.A.S.» que nadie se sabe de memoria.
 *
 * Y NO BUSCA «CUALQUIER NOMBRE CON S.A.S. DETRÁS», que es la versión que se
 * escribe sola y que en un contrato entre dos empresas acierta la mitad de las
 * veces. La mitad de las veces es intolerable para un dato que se va a repetir
 * en cada respuesta durante meses.
 */
export function findOwnLegalName(text: string, typedName: string): TextFinding | null {
  const words = typedName
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;

  // El nombre tecleado puede venir ya con la forma societaria («Coltrans
  // S.A.S.»). `nameKey` la quita, y lo que se busca en el texto son las
  // palabras de verdad — si no, se buscaría «Coltrans S.A.S. S.A.S.».
  const core = nameKey(typedName);
  if (core.length < 3) return null;
  const stripped = words.filter((w) => nameKey(w).length > 0 && core.includes(nameKey(w)));
  const needle = (stripped.length > 0 ? stripped : words).map(escapeRegExp).join('\\s+');

  const folded = foldSameLength(text);
  const pattern = new RegExp(`${foldSameLength(needle)}[\\s,]+${LEGAL_SUFFIX}${SUFFIX_END}`, 'gi');

  const hit = pattern.exec(folded);
  if (!hit || hit.index === undefined) return null;

  // Se recorta del ORIGINAL, en los mismos índices, para conservar las
  // mayúsculas y las tildes tal como las escribieron ellos.
  const value = text
    .slice(hit.index, hit.index + hit[0].length)
    .replace(/\s+/g, ' ')
    .trim();
  return { value, quote: lineAt(text, hit.index), at: hit.index };
}

// ---------------------------------------------------------------------------
// Las dos cosas juntas
// ---------------------------------------------------------------------------

export interface IdentityOptions {
  /** Lo que tecleó la persona. Es el desempate, no una pista. */
  typedName: string;
  /**
   * Los NIT que ya se sabe de quién son: los de sus clientes registrados.
   * Sólo dígitos, sin DV — como está en `clients.tax_id`.
   */
  excludeNitDigits?: Iterable<string>;
}

export interface Identity {
  legalName: TextFinding | null;
  nit: TextFinding | null;
}

/**
 * Cuántos caracteres puede haber entre el nombre y el NIT para que se acepte
 * que el NIT es de ese nombre.
 *
 * «COLTRANS S.A.S., sociedad comercial identificada con NIT 900.123.456-7 y
 * domiciliada en Bogotá» cabe de sobra. El NIT de la otra parte, que en un
 * contrato aparece en el párrafo siguiente, no.
 */
const NEAR = 240;

/**
 * El cuerpo del NIT, sin el dígito de verificación: la forma en que se compara.
 *
 * `clients.tax_id` guarda el NIT SIN el dígito y este archivo devuelve el NIT
 * CON él, así que comparar las dos cadenas tal cual no coincidiría nunca — y el
 * filtro que impide proponer el NIT de un cliente como propio habría existido
 * sin hacer nada, que es la peor clase de filtro.
 */
function withoutDv(raw: string): string {
  const [body] = raw.split(/[-–—]/);
  return normalizeNit(body ?? raw);
}

/**
 * La identidad que este texto respalda, o dos nulos.
 *
 * ===========================================================================
 * CUÁNDO DEVUELVE NIT Y CUÁNDO SE CALLA — QUE ES LO QUE HAY QUE MIRAR
 * ===========================================================================
 *
 *   Si se reconoció la razón social: el NIT más cercano a ella, y sólo si está
 *   lo bastante cerca. Es el caso bueno y es el encabezamiento de cualquier
 *   contrato colombiano.
 *
 *   Si NO se reconoció la razón social: sólo si en todo el texto queda UN
 *   ÚNICO NIT candidato. Con uno, no hay nada que confundir. Con dos, no hay
 *   forma de saber cuál es el suyo, y ELEGIR UNO SERÍA ACERTAR A CARA O CRUZ un
 *   dato que después se cita con seguridad durante meses. Se devuelve null, y
 *   el campo se queda vacío, que es la respuesta correcta.
 */
export function pickIdentity(text: string, opts: IdentityOptions): Identity {
  const exclude = new Set<string>();
  for (const raw of opts.excludeNitDigits ?? []) {
    const digits = withoutDv(raw);
    if (digits) exclude.add(digits);
  }

  const legalName = findOwnLegalName(text, opts.typedName);
  const candidates = findNits(text).filter((f) => !exclude.has(withoutDv(f.value)));

  if (candidates.length === 0) return { legalName, nit: null };

  if (legalName) {
    const nearest = [...candidates].sort(
      (a, b) => Math.abs(a.at - legalName.at) - Math.abs(b.at - legalName.at),
    )[0] as TextFinding;
    return { legalName, nit: Math.abs(nearest.at - legalName.at) <= NEAR ? nearest : null };
  }

  return { legalName: null, nit: candidates.length === 1 ? (candidates[0] as TextFinding) : null };
}
