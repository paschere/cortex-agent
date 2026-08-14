import {
  COMPANY_FACTS_BUDGET,
  COMPANY_FACTS_MAX,
  COMPANY_FACT_LABEL_MAX,
  COMPANY_FACT_VALUE_MAX,
  type WeighableFact,
  weighCompanyFactHere,
  weighCompanyFactsHere,
} from '@/lib/company-facts-shape';

/**
 * LA SELECCIÓN DE LO QUE SE PROPONE. PURA, Y ES DONDE VIVE TODO LO QUE PUEDE
 * SALIR MAL EN SILENCIO.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN ARCHIVO APARTE Y NO TRES `if` DENTRO DEL RECOLECTOR
 * ===========================================================================
 * La ficha de la empresa entra ENTERA en el prompt de cada turno de cada
 * superficie. Un dato equivocado aquí no arruina una respuesta: arruina todas,
 * durante meses, dicho con seguridad, y nadie lo nota porque ese dato ya no se
 * vuelve a mirar. El recolector —que habla con la base, con el cerebro y con la
 * web— no se puede probar sin levantar medio producto. Esto sí: recibe una lista
 * de candidatos y devuelve la propuesta, y por tanto las cuatro reglas que de
 * verdad protegen la ficha se comprueban con aritmética en Node.
 *
 * NADA DE AQUÍ LLAMA A UN MODELO NI PODRÍA. No hay red, no hay reloj, no hay
 * base de datos, no hay un solo import que no sea la copia del medidor. Es el
 * mismo contrato que `company/shape.ts` en el paquete y por el mismo motivo.
 *
 * ===========================================================================
 * LAS CUATRO REGLAS, EN ORDEN DE CUÁNTO DAÑO EVITAN
 * ===========================================================================
 *
 *   1. LO QUE NO SE ENCONTRÓ SE QUEDA VACÍO. Un candidato sin valor no se
 *      propone, no se propone «(no encontrado)», y no se propone un valor
 *      verosímil. Sale en `unresolved`, que es una lista de preguntas sin
 *      responder y no de respuestas inventadas. Un hueco es infinitamente mejor
 *      que un relleno: el hueco se ve, el relleno se cita.
 *
 *   2. UN VALOR SIN PROCEDENCIA NO EXISTE. `docs/design-system.md` dice que un
 *      valor sin procedencia no lleva chip; aquí la consecuencia es más dura,
 *      porque un valor propuesto SIN chip sería un valor que la persona aprueba
 *      sin saber de dónde salió — que es exactamente la aprobación que no vale
 *      nada. Así que se descarta, no se pinta sin chip.
 *
 *   3. NUNCA SE PISA LO QUE ALGUIEN YA ESCRIBIÓ. Si la ficha ya responde
 *      «NIT», ningún candidato para «NIT» se propone, venga de donde venga.
 *      Una persona escribió eso a mano; una expresión regular sobre una página
 *      web no es motivo para ofrecerle cambiarlo, y ofrecérselo es la forma más
 *      fácil de que un día lo acepte sin mirar.
 *
 *   4. NUNCA SE RECORTA UN VALOR PARA QUE QUEPA. Un valor más largo del tope se
 *      descarta entero. Un NIT truncado sigue pareciendo un NIT, y una razón
 *      social a la que le falta el final sigue pareciendo una razón social: los
 *      dos se aprobarían de un vistazo y los dos serían falsos.
 *
 * ===========================================================================
 * Y LA QUINTA, QUE ES DE ORDEN Y NO DE DESCARTE: LA FIABILIDAD DE LA FUENTE
 * ===========================================================================
 * Cuando dos fuentes responden a la misma pregunta no se promedia ni se elige
 * la primera que llegó: gana la más fiable, y LA OTRA NO DESAPARECE — queda en
 * `alternatives`, a un clic. Esto no es cortesía. «Plazo de pago» sale del
 * contrato como 30 días y de los pagos observados como 47, y las dos son
 * verdad: una es lo pactado y otra lo que pasa. Quien decide tiene que ver las
 * dos, porque la respuesta correcta depende de para qué la quiere.
 */

// ---------------------------------------------------------------------------
// Las fuentes
// ---------------------------------------------------------------------------

/**
 * De dónde puede salir un valor, ordenado por cuánto se le puede creer.
 *
 * `registry` ES EL HUECO DE RUES Y ESTÁ AQUÍ A PROPÓSITO, VACÍO.
 * El registro mercantil es la fuente canónica de la razón social, el NIT, la
 * matrícula, el CIIU, el domicilio y el representante legal. Hoy no hay ninguna
 * forma de leerlo: `browser_flows` no tiene ningún trámite de RUES grabado, y
 * grabarlo exige a una persona delante del navegador. NO se ha escrito el
 * conector, y esa decisión está argumentada en `gather.ts`.
 *
 * Lo que sí se ha hecho es dejar el escalón: el día que exista un trámite de
 * RUES, sus candidatos entran con `kind: 'registry'` y ganan al contrato y a la
 * web sin tocar una línea de la selección. Un escalón en una tabla de rangos es
 * dato; un conector a una fuente cuya forma de respuesta nadie ha visto todavía
 * sería código muerto escrito a partir de suposiciones de hoy.
 */
export type ProposalSource = 'registry' | 'document' | 'workspace' | 'web';

/**
 * El rango. Más bajo gana.
 *
 * `document` POR ENCIMA DE `workspace` y no al revés, que es la única de las
 * cuatro que no es obvia: un contrato trae la razón social y el NIT escritos y
 * firmados por ellos, mientras que lo que el espacio sabe de sí mismo son
 * derivaciones —el nombre que alguien le puso al espacio de trabajo, una
 * mediana de pagos— que son exactas como cálculo y aproximadas como respuesta.
 *
 * `web` SIEMPRE LA ÚLTIMA. Para un dato legal es la fuente más débil que hay.
 */
const SOURCE_RANK: Record<ProposalSource, number> = {
  registry: 0,
  document: 1,
  workspace: 2,
  web: 3,
};

/**
 * Las fuentes que un botón puede aceptar en bloque, y las que no.
 *
 * ===========================================================================
 * POR QUÉ HAY UN «ACEPTAR TODOS» Y POR QUÉ NO ACEPTA TODO
 * ===========================================================================
 * Un «aceptar todos» sin condiciones convierte la revisión campo por campo en
 * un adorno: un clic y doce valores leídos de una página web entran en el
 * prompt de cada respuesta para siempre. Quitarlo del todo tampoco vale, porque
 * entonces confirmar doce datos que salieron de sus propios contratos y de sus
 * propios pagos son doce clics, y lo que se hace doce veces se hace sin mirar.
 *
 * Así que el botón existe y está ACOTADO POR LA PROCEDENCIA, que es justo lo
 * que hace que aprobar sea seguro: acepta lo que salió del registro, de sus
 * documentos y de sus propios datos, y NUNCA lo que salió de la web. Un valor
 * de la web se acepta de uno en uno o no se acepta.
 */
export const BULK_ACCEPTABLE: readonly ProposalSource[] = ['registry', 'document', 'workspace'];

export function isBulkAcceptable(source: ProposalSource): boolean {
  return BULK_ACCEPTABLE.includes(source);
}

/**
 * De dónde salió esto, tal como se pinta en el chip.
 *
 * Los tres campos espejan `<Provenance source readAt detail />` a propósito:
 * la pantalla no tiene que traducir nada, y por tanto no puede traducir mal.
 */
export interface FactProvenance {
  kind: ProposalSource;
  /** El sistema o el documento: «Tus pagos», «Contrato Coltrans», «coltrans.com». */
  source: string;
  /** Cuándo se leyó, ya formateado para una persona: «12 mar 2026», «hoy». */
  readAt?: string;
  /** Un calificador corto: «24 pagos», «pie de página», «mediana». */
  detail?: string;
  /**
   * El renglón literal donde se leyó el valor, cuando se leyó de un texto.
   *
   * NO VA EN EL CHIP —el chip es una cápsula de tres datos cortos y un renglón
   * de contrato no cabe— sino debajo, en monoespaciada. Es la pieza que
   * convierte «confía en el sello» en «míralo tú»: la diferencia entre aprobar
   * un NIT porque lo dice la pantalla y aprobarlo porque ves la frase
   * «identificada con NIT 900.373.115-3» de tu propio contrato.
   *
   * Vacío para lo que no es una cita, como una mediana de pagos, que no está
   * escrita en ningún sitio porque es una cuenta.
   */
  quote?: string;
}

/** Un valor que una fuente ofrece para un campo. Todavía no es una propuesta. */
export interface FactCandidate {
  section: string;
  label: string;
  /** Vacío o en blanco significa NO ENCONTRADO, y se descarta. Nunca se rellena. */
  value: string;
  provenance: FactProvenance;
}

// ---------------------------------------------------------------------------
// Lo que sale
// ---------------------------------------------------------------------------

export interface FactAlternative {
  value: string;
  provenance: FactProvenance;
}

export interface ProposedFact {
  /** Clave estable dentro de una propuesta. La pantalla la usa para marcar. */
  key: string;
  section: string;
  label: string;
  value: string;
  provenance: FactProvenance;
  /** Otras respuestas a la misma pregunta, de fuentes menos fiables. */
  alternatives: FactAlternative[];
  /** Lo que este dato ocuparía del presupuesto, formato incluido. */
  weight: number;
}

/** Una pregunta que nadie respondió. NO es un valor vacío: es un hueco con nombre. */
export interface UnresolvedField {
  section: string;
  label: string;
}

export interface Proposal {
  facts: ProposedFact[];
  unresolved: UnresolvedField[];
  /** Lo que la ficha ya ocupa hoy, sin aceptar nada. */
  usedNow: number;
  /** Lo que ocuparía si se aceptara la propuesta entera. */
  usedIfAll: number;
  budget: number;
  /**
   * Aceptar la propuesta entera se pasaría del tope.
   *
   * SE DICE ANTES DE ACEPTAR, no al guardar. El guardado también lo rechaza
   * —`writeCompanyFact` es la puerta y vuelve a pesar— pero enterarse ahí es
   * enterarse cuando ya elegiste, y la frase útil es la que llega mientras
   * todavía puedes descartar dos.
   */
  overIfAll: boolean;
  /** Cuántos datos habría en la ficha si se aceptara todo. Contra COMPANY_FACTS_MAX. */
  countIfAll: number;
  overCountIfAll: boolean;
}

export interface SelectOptions {
  /** Lo que YA está guardado. Se usa para no pisarlo y para pesar de verdad. */
  written: WeighableFact[];
  /** slug → nombre de sección. Igual que el medidor: un argumento, no una copia. */
  sectionNames: Record<string, string>;
  /** El orden en que se pintan las secciones. Fuera de esta lista no se propone. */
  sectionOrder: string[];
  /** Los campos sugeridos por sección, para poder decir cuáles quedaron sin responder. */
  suggested: Record<string, string[]>;
}

// ---------------------------------------------------------------------------

/**
 * Cómo se compara una etiqueta con otra.
 *
 * Sin tildes y sin mayúsculas, porque «Razón social» y «RAZON SOCIAL» son la
 * misma pregunta y proponer la segunda cuando la primera ya está respondida
 * sería ofrecer un duplicado que la base rechazaría después
 * (`company_facts_label_once_idx`) con un error que nadie entiende.
 */
export function labelKey(raw: string): string {
  return (
    raw
      .normalize('NFD')
      // Sólo diacríticos combinantes (U+0300–U+036F), todos dentro del BMP.
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: rango sin pares subrogados
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Dos valores que sólo se diferencian en espacios son el mismo valor. */
function valueKey(raw: string): string {
  return labelKey(raw);
}

/**
 * La clave de una pregunta: sección y etiqueta, en una cadena.
 *
 * El separador es `\u0000` y no `:` o un espacio porque una etiqueta SÍ puede
 * llevar dos puntos («Plazo de pago: exportación») y un carácter nulo no puede
 * estar dentro de una: Postgres lo rechaza en un `text`. Con un separador que
 * cabe en una etiqueta, dos preguntas distintas pueden colisionar en la misma
 * clave, y una colisión aquí significa proponer un dato encima de otro.
 */
function factKey(section: string, label: string): string {
  return `${section}\u0000${labelKey(label)}`;
}

/**
 * LA FUNCIÓN. Candidatos entran, propuesta sale.
 *
 * Determinista de principio a fin: mismos candidatos, misma propuesta. Eso es lo
 * que permite que las pruebas de este módulo digan algo — una selección que
 * dependiera de en qué orden contestó la red no se podría afirmar.
 */
export function selectProposal(candidates: FactCandidate[], opts: SelectOptions): Proposal {
  const known = new Set(opts.sectionOrder);
  const writtenKeys = new Set(opts.written.map((f) => factKey(f.section, f.label)));

  // --- Paso 1: descartar. Cada `continue` de aquí es una de las cuatro reglas.
  const kept: FactCandidate[] = [];
  for (const c of candidates) {
    // Una sección que no está en el registro no es una sección nueva: es un
    // error de quien recolectó. Mismo criterio que `renderCompanyFactsBlock`.
    if (!known.has(c.section)) continue;

    const value = c.value.trim();
    const label = c.label.trim();

    // REGLA 1. No encontrado se queda vacío.
    if (value.length === 0) continue;
    // REGLA 2. Sin procedencia no existe.
    if (!c.provenance || c.provenance.source.trim().length === 0) continue;
    // REGLA 4. Nunca se recorta.
    if (value.length > COMPANY_FACT_VALUE_MAX) continue;
    if (label.length < 2 || label.length > COMPANY_FACT_LABEL_MAX) continue;
    // REGLA 3. No se pisa lo escrito.
    if (writtenKeys.has(factKey(c.section, label))) continue;

    kept.push({ ...c, value, label });
  }

  // --- Paso 2: agrupar por pregunta y ordenar por fiabilidad.
  //
  // El orden dentro del grupo se decide por rango de fuente, y los empates se
  // rompen por el orden en que llegaron. `Array.prototype.sort` es estable
  // desde ES2019, así que esto es una promesa del lenguaje y no una casualidad
  // del motor: dos candidatos de la misma fuente salen en el orden en que el
  // recolector los puso, y por tanto la propuesta se puede afirmar en una
  // prueba.
  const groups = new Map<string, FactCandidate[]>();
  for (const c of kept) {
    const key = factKey(c.section, c.label);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const facts: ProposedFact[] = [];
  for (const [key, bucket] of groups) {
    const ordered = [...bucket].sort(
      (a, b) => SOURCE_RANK[a.provenance.kind] - SOURCE_RANK[b.provenance.kind],
    );
    const winner = ordered[0] as FactCandidate;

    // Una fuente peor que dice LO MISMO no es una alternativa, es una
    // confirmación, y pintarla como si hubiera que elegir entre dos convierte
    // un acuerdo en una duda.
    const seen = new Set([valueKey(winner.value)]);
    const alternatives: FactAlternative[] = [];
    for (const other of ordered.slice(1)) {
      const vk = valueKey(other.value);
      if (seen.has(vk)) continue;
      seen.add(vk);
      alternatives.push({ value: other.value, provenance: other.provenance });
    }

    facts.push({
      key,
      section: winner.section,
      label: winner.label,
      value: winner.value,
      provenance: winner.provenance,
      alternatives,
      weight: weighCompanyFactHere(winner),
    });
  }

  // --- Paso 3: ordenar como se lee la ficha, no como llegó la red.
  const sectionAt = new Map(opts.sectionOrder.map((s, i) => [s, i]));
  const suggestedAt = (section: string, label: string) => {
    const list = opts.suggested[section] ?? [];
    const i = list.findIndex((s) => labelKey(s) === labelKey(label));
    // Lo que nadie sugirió va después de lo sugerido, no antes: la persona está
    // buscando las respuestas a las preguntas que la pantalla ya le hacía.
    return i === -1 ? list.length : i;
  };
  facts.sort((a, b) => {
    const bySection =
      (sectionAt.get(a.section) ?? Number.MAX_SAFE_INTEGER) -
      (sectionAt.get(b.section) ?? Number.MAX_SAFE_INTEGER);
    if (bySection !== 0) return bySection;
    const byField = suggestedAt(a.section, a.label) - suggestedAt(b.section, b.label);
    if (byField !== 0) return byField;
    return a.label.localeCompare(b.label, 'es');
  });

  // --- Paso 4: los huecos. Lo que se preguntaba y sigue sin respuesta.
  const answered = new Set(facts.map((f) => f.key));
  const unresolved: UnresolvedField[] = [];
  for (const section of opts.sectionOrder) {
    for (const label of opts.suggested[section] ?? []) {
      const key = factKey(section, label);
      if (answered.has(key) || writtenKeys.has(key)) continue;
      unresolved.push({ section, label });
    }
  }

  // --- Paso 5: el presupuesto, dicho antes y no al guardar.
  const usedNow = weighCompanyFactsHere(opts.written, opts.sectionNames);
  const usedIfAll = weighCompanyFactsHere(
    [
      ...opts.written,
      ...facts.map((f) => ({ section: f.section, label: f.label, value: f.value })),
    ],
    opts.sectionNames,
  );
  const countIfAll = opts.written.length + facts.length;

  return {
    facts,
    unresolved,
    usedNow,
    usedIfAll,
    budget: COMPANY_FACTS_BUDGET,
    overIfAll: usedIfAll > COMPANY_FACTS_BUDGET,
    countIfAll,
    overCountIfAll: countIfAll > COMPANY_FACTS_MAX,
  };
}

/**
 * Lo que ocuparía la ficha si se aceptara ESTA selección y no la propuesta
 * entera.
 *
 * La pantalla la llama con lo que hay marcado, para que el medidor se mueva
 * mientras alguien marca y desmarca. Es el mismo argumento que el medidor de
 * `CompanyBoard`: el momento de enterarse de que no cabe es mientras eliges.
 */
export function weighSelection(
  written: WeighableFact[],
  chosen: Array<{ section: string; label: string; value: string }>,
  sectionNames: Record<string, string>,
): number {
  return weighCompanyFactsHere([...written, ...chosen], sectionNames);
}
