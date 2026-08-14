/**
 * La ficha de la empresa: las secciones, el presupuesto y el bloque de prompt.
 *
 * PURO. Ni base de datos, ni reloj, ni red, ni un solo import. Es el mismo
 * contrato que `memory/prompt.ts` —el archivo que este copia— y por la misma
 * razón: lo que entra en el prompt de cada turno de cada superficie tiene que
 * poder probarse caso por caso en Node, sin levantar nada.
 *
 * Las tres piezas que viven aquí y en ningún otro sitio:
 *
 *   COMPANY_SECTIONS   El registro cerrado de secciones, con su nombre en
 *                      español y sus campos SUGERIDOS. Es dato de producto, no
 *                      de esquema: la 0104 comprueba la FORMA del slug y no la
 *                      lista, para que añadir una sugerencia sea un renglón
 *                      aquí y no una migración.
 *   weighCompanyFacts  Cuánto del presupuesto se lleva usado. Una función, un
 *                      número, y la pantalla y la puerta de escritura leen el
 *                      mismo.
 *   renderCompanyFacts El bloque, entero, tal como se concatena en el prompt.
 */

/** Un hecho de la empresa, como se guarda y como se inyecta. */
export interface CompanyFact {
  section: string;
  label: string;
  value: string;
}

/** Una sección de la ficha, con lo que sugiere que le pongas. */
export interface CompanySection {
  /** Slug estable. Es lo que va en `company_facts.section`. */
  key: string;
  /** Cómo se llama en pantalla y en el bloque del prompt. */
  name: string;
  /** Una línea que dice para qué sirve, para el estado vacío de la pantalla. */
  blurb: string;
  /**
   * Campos sugeridos, en el orden en que se ofrecen.
   *
   * SUGERIDOS Y NO OBLIGATORIOS, Y ESA ES LA DECISIÓN DEL MÓDULO. Un formulario
   * fijo de cuarenta casillas es un formulario que nadie termina y que además
   * miente: se rellenan las ocho primeras, las treinta y dos restantes quedan
   * vacías, y una ficha medio vacía se lee como un producto roto. Estos nombres
   * son un punto de partida —un botón que precarga la etiqueta— y cualquiera
   * puede escribir la suya o borrar la que no aplica.
   */
  suggested: string[];
}

/**
 * LAS CINCO SECCIONES, EN EL ORDEN EN QUE SE LEEN Y EN QUE SE INYECTAN.
 *
 * Están pensadas para una empresa colombiana real y no para un CRM: la pregunta
 * que responde cada una es una que alguien de la empresa hace en voz alta, no un
 * campo de un modelo de datos.
 *
 * EL ORDEN NO ES ALFABÉTICO NI CASUAL. Identidad primero porque es lo que hace
 * que Cortex sepa de quién habla; «Lo que no» AL FINAL porque una restricción
 * pesa más cuando es lo último que el modelo leyó antes de la pregunta, y porque
 * es la única sección cuyo contenido no es información sino instrucción.
 *
 * LO QUE DELIBERADAMENTE NO ES UNA SECCIÓN: los clientes y los proveedores. Ya
 * tienen su propio módulo con su tabla, su búsqueda y sus herramientas
 * (`clients.*`), y una sección aquí sería una SEGUNDA lista de clientes que
 * envejece por su cuenta — dos respuestas a «¿quiénes son nuestros clientes?»,
 * de las cuales la que va en el prompt gana a la que está bien. Lo que sí cabe
 * aquí es la FORMA de la relación («le vendemos a constructoras, no a
 * particulares»), que es un hecho estable y no una lista.
 */
export const COMPANY_SECTIONS: readonly CompanySection[] = [
  {
    key: 'identidad',
    name: 'Identidad',
    blurb:
      'Quién es la empresa, en los términos en que la conoce la DIAN y en los que la conoce un cliente.',
    suggested: [
      'Razón social',
      'NIT',
      'A qué se dedica',
      'Dónde opera',
      'Desde cuándo',
      'Cuánta gente somos',
      'Régimen tributario',
    ],
  },
  {
    key: 'ingresos',
    name: 'Cómo entra la plata',
    blurb:
      'Qué se vende, a quién, y bajo qué condiciones se cobra. Es lo que más cambia una respuesta de Cortex sobre dinero.',
    suggested: [
      'Qué vendemos',
      'A quién le vendemos',
      'Cómo se cobra',
      'Plazo de pago',
      'Moneda',
      'Quién factura',
    ],
  },
  {
    key: 'personas',
    name: 'Quién es quién',
    blurb:
      'Los nombres que hay que saber y qué decide cada uno. No es el organigrama: es a quién hay que preguntarle.',
    suggested: [
      'Gerente general',
      'Quién aprueba pagos',
      'Quién firma contratos',
      'Quién atiende a los clientes',
    ],
  },
  {
    key: 'operacion',
    name: 'Cómo se trabaja aquí',
    blurb:
      'El horario, las herramientas, las reglas internas y cómo se llaman las cosas cuando alguien las nombra sin explicar.',
    suggested: [
      'Horario',
      'Herramientas que usamos',
      'Reglas internas',
      'Cómo llamamos a las cosas',
    ],
  },
  {
    key: 'limites',
    name: 'Lo que no',
    blurb:
      'Lo que Cortex no debe hacer ni decir por su cuenta. Va de último a propósito: es lo último que lee antes de contestar.',
    suggested: [
      'Qué no debe hacer sin permiso',
      'Qué no se dice por fuera',
      'Con quién no habla directo',
    ],
  },
] as const;

export const COMPANY_SECTION_KEYS: readonly string[] = COMPANY_SECTIONS.map((s) => s.key);

export class UnknownCompanySectionError extends Error {
  constructor(section: string) {
    super(
      `«${section}» no es una sección de la ficha de la empresa. Las que hay: ${COMPANY_SECTION_KEYS.join(', ')}.`,
    );
    this.name = 'UnknownCompanySectionError';
  }
}

export function companySectionByKey(key: string): CompanySection {
  const found = COMPANY_SECTIONS.find((s) => s.key === key);
  if (!found) throw new UnknownCompanySectionError(key);
  return found;
}

// ---------------------------------------------------------------------------
// El presupuesto
// ---------------------------------------------------------------------------

/**
 * EL TOPE DURO, EN CARACTERES.
 *
 * ===========================================================================
 * POR QUÉ HAY UN TOPE
 * ===========================================================================
 * Este bloque no se recupera: entra ENTERO en cada turno de la web, de Google
 * Chat, de MCP y de cada rutina desatendida. Eso es coste de verdad en cada
 * mensaje que manda cualquiera de la empresa, para siempre — y, lo que importa
 * más, es contexto que se le quita a otra cosa. La pantalla de peso del turno
 * (`ContextWeight`) existe precisamente porque «tenía la respuesta y estaba
 * enterrada bajo nueve décimas partes de otra cosa» es el motivo más común de
 * una respuesta pobre. Un bloque de empresa sin techo es la forma más fácil de
 * convertirse en esa novena parte.
 *
 * ===========================================================================
 * POR QUÉ 4.000 Y NO OTRO NÚMERO
 * ===========================================================================
 * Tres referencias, todas del propio producto:
 *
 *   El techo de las memorias personales es 40 × 240 = 9.600 caracteres (0051).
 *   La ficha de la empresa la lee TODO el mundo en TODOS los turnos, mientras
 *   que las memorias las lee una persona en los suyos, así que tiene que pesar
 *   claramente menos que el peor caso de aquello. 4.000 es un 42 % de esa cifra.
 *
 *   En español pesado de tildes salen unos ~3,6 caracteres por token, así que
 *   4.000 caracteres son ~1.100 tokens. Es una ficha, no un manual.
 *
 *   A ~90 caracteres por hecho —una etiqueta corta y una respuesta de renglón y
 *   medio— caben unos 44 hechos. Las cinco secciones con ocho o nueve líneas
 *   cada una entran holgadas, y un manual de convivencia no.
 *
 * El número es una decisión, no una constante de la naturaleza: si mañana se
 * sube, se sube AQUÍ y `company-facts-shape.test.ts` sigue midiendo lo mismo.
 */
export const COMPANY_FACTS_BUDGET = 4000;

/** Lo más largo que puede ser una etiqueta. Espeja el CHECK de la 0104. */
export const COMPANY_FACT_LABEL_MAX = 60;

/** Lo más largo que puede ser un valor. Espeja el CHECK de la 0104. */
export const COMPANY_FACT_VALUE_MAX = 300;

/**
 * Cuántos hechos, como mucho.
 *
 * El presupuesto ya acota el total, pero acota MAL el número de filas: 4.000
 * caracteres admiten quinientos hechos de siete letras, y quinientas filas no
 * son una ficha, son una pantalla que nadie puede leer. Este tope es de
 * usabilidad y el otro de coste; hacen falta los dos.
 */
export const COMPANY_FACTS_MAX = 120;

/**
 * Lo que un hecho le cuesta al bloque, contando el formato que arrastra.
 *
 * Se cuenta `- Etiqueta: valor\n` y no `label.length + value.length` porque lo
 * que se mide tiene que ser lo que de verdad se envía. Es el mismo criterio que
 * `recorder.part(...)` en la ruta del chat: ahí los porcentajes son exactos
 * porque se miden sobre la cadena que se concatenó, y un medidor que midiera
 * otra cosa sería un medidor que hay que reconciliar a mano.
 */
export function weighCompanyFact(fact: CompanyFact): number {
  return `- ${fact.label.trim()}: ${fact.value.trim()}\n`.length;
}

/**
 * Cuánto del presupuesto se llevan estos hechos.
 *
 * Incluye los encabezados de las secciones que los hechos HACEN aparecer —una
 * sección sin hechos no se dibuja y por tanto no pesa—, y NO incluye el marco
 * fijo (la etiqueta XML y las reglas). Esa exclusión es deliberada: el marco es
 * el mismo para todo el mundo, nadie puede acortarlo, y un medidor que arranca
 * en el 12 % antes de que escribas nada enseña a ignorar el medidor. Lo que la
 * pantalla mide es lo que la pantalla controla.
 */
export function weighCompanyFacts(facts: CompanyFact[]): number {
  const sections = new Set<string>();
  let total = 0;
  for (const fact of facts) {
    total += weighCompanyFact(fact);
    sections.add(fact.section);
  }
  for (const key of sections) {
    const section = COMPANY_SECTIONS.find((s) => s.key === key);
    // Una sección desconocida no debería llegar aquí —`writeCompanyFact` la
    // rechaza—, pero si llegara se pesa por su slug en vez de desaparecer del
    // conteo: un medidor que se olvida de lo que no reconoce miente por lo bajo.
    total += `\n## ${section?.name ?? key}\n`.length;
  }
  return total;
}

/** El presupuesto, resuelto: lo que se usó, lo que queda y si se pasó. */
export interface CompanyFactsBudget {
  used: number;
  limit: number;
  remaining: number;
  /** 0–1. Puede pasar de 1: pasarse se enseña, no se esconde. */
  share: number;
  over: boolean;
  count: number;
}

export function companyFactsBudget(facts: CompanyFact[]): CompanyFactsBudget {
  const used = weighCompanyFacts(facts);
  return {
    used,
    limit: COMPANY_FACTS_BUDGET,
    remaining: COMPANY_FACTS_BUDGET - used,
    share: used / COMPANY_FACTS_BUDGET,
    over: used > COMPANY_FACTS_BUDGET,
    count: facts.length,
  };
}

// ---------------------------------------------------------------------------
// El bloque
// ---------------------------------------------------------------------------

/**
 * Las reglas que acompañan a los hechos.
 *
 * En inglés, como las de `renderMemoryBlock`, porque el prompt del agente que
 * las rodea está en inglés y mezclar los dos idiomas en las INSTRUCCIONES —no en
 * los datos, que van tal como los escribió la persona— es pedirle al modelo que
 * decida en cuál está trabajando.
 *
 * Fíjate en lo que estas reglas NO dicen, y en lo que sí, comparadas con las de
 * las memorias:
 *
 *   Las memorias llevan «never read them back, never list them». Aquí es al
 *   REVÉS: la ficha se puede citar sin problema, porque no es de una persona.
 *   Si alguien pregunta «¿cuál es nuestro NIT?», contestarlo es exactamente el
 *   trabajo, y una regla de discreción copiada sin pensar habría hecho que
 *   Cortex se negara a decir su propio NIT a su propio dueño.
 *
 *   Sí se conserva la regla de precedencia, y por el mismo motivo: lo que
 *   alguien dice ahora es más nuevo que lo que se escribió en la ficha.
 */
const COMPANY_RULES = [
  'This is the company you work for, written down by the people who run it. Treat every line as true and act on it without asking again.',
  'It is not a secret and it is not personal: you may quote any of it back when someone asks. It is the company describing itself to you.',
  'If a line here contradicts what someone tells you right now, the person wins for this conversation — but say that the written fact disagrees, so somebody can go and fix it.',
  'If something you need is not written here, say you do not have it and point at "Datos de la empresa" in the sidebar. Never invent a NIT, a payment term, a price or a person.',
];

/**
 * El bloque, exactamente como se concatena en el prompt.
 *
 * SIN HECHOS DEVUELVE CADENA VACÍA, igual que `renderMemoryBlock`. No devuelve
 * un bloque con las cinco secciones vacías ni una frase que diga que no se sabe
 * nada: un espacio de trabajo recién creado no debe pagar tokens por un
 * formulario en blanco, y `buildSystemPrompt` ya filtra las partes vacías.
 *
 * NUNCA TRUNCA. Si los hechos se pasan del presupuesto, salen todos igual. El
 * presupuesto se hace cumplir donde se puede explicar —la puerta de escritura,
 * que rechaza con la cifra, y la pantalla, que enseña el medidor—, no aquí,
 * donde recortar significaría que una instrucción de «Lo que no» desaparece del
 * prompt sin que nadie lo vea. Un límite que se aplica en silencio en el sitio
 * más profundo del sistema es peor que no tener límite.
 */
export function renderCompanyFactsBlock(facts: CompanyFact[]): string {
  if (facts.length === 0) return '';

  const lines: string[] = [];
  for (const section of COMPANY_SECTIONS) {
    const own = facts
      .filter((f) => f.section === section.key)
      .filter((f) => f.label.trim().length > 0 && f.value.trim().length > 0);
    if (own.length === 0) continue;
    lines.push('', `## ${section.name}`);
    for (const fact of own) lines.push(`- ${fact.label.trim()}: ${fact.value.trim()}`);
  }

  // Una sección que no está en el registro no se dibuja. Es el mismo criterio
  // que el resto del módulo: el registro manda, y una fila con un slug que nadie
  // reconoce es un error de datos, no una sección nueva.
  if (lines.length === 0) return '';

  return ['<about_this_company>', ...COMPANY_RULES, ...lines, '</about_this_company>'].join('\n');
}
