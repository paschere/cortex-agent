/**
 * CUANDO EL MODELO DEVUELVE LA FORMA CORRECTA DENTRO DE LA FORMA EQUIVOCADA.
 *
 * ===========================================================================
 * LO QUE PASA DE VERDAD, MEDIDO CONTRA LA API
 * ===========================================================================
 * `generateObject` sobre Anthropic no es «modo JSON»: la SDK 4 lo implementa
 * como una herramienta forzada (`mode: 'object-tool'` en
 * @ai-sdk/anthropic@1.2.12), o sea que manda un `tool_choice: {type:'tool'}` y
 * lee los argumentos de la llamada. Sonnet 5, con este esquema, mete el objeto
 * ENTERO como CADENA dentro de la primera propiedad:
 *
 *     esperado   { "tasks": [ {…}, {…} ] }
 *     recibido   { "tasks": "{\"tasks\":[ {…}, {…} ]}" }
 *
 * El contenido está bien —los planes son correctos, con sus dependencias y sus
 * herramientas— y lo único roto es el envoltorio. Zod rechaza, la SDK levanta
 * `NoObjectGeneratedError`, y el turno muere después de veinte segundos.
 *
 * ===========================================================================
 * POR QUÉ NO SE ARREGLA CON BANDERAS DEL PROVEEDOR. TRES INTENTOS Y UNA MEDIDA
 * ===========================================================================
 * Este fallo ya se «arregló» dos veces cambiando cómo se le pide al modelo que
 * piense, y volvió las dos veces. El 17-08-2026 se midió en vez de suponerse:
 * seis llamadas por configuración, tres objetivos distintos.
 *
 *     thinking disabled (lo que corría)      0/6 correctas
 *     thinking adaptive + summarized + max   0/6 correctas
 *
 * Cero y cero. La combinación que en su día pareció buena acertó tres veces
 * seguidas sobre UN objetivo y falla en cuanto cambia el objetivo: era
 * sobreajuste a un prompt, no un arreglo. Y la variante `display:'off'` ni
 * siquiera existe — la API contesta 400, sólo acepta `summarized` u `omitted`.
 *
 * Así que la conclusión es la contraria a la de los dos intentos anteriores: la
 * configuración de pensamiento NO es la palanca de este fallo. Buscar la
 * bandera mágica es perseguir una lotería que cambia con cada versión del
 * modelo. Lo que sí es determinista es que el CONTENIDO siempre llega bien.
 *
 * ===========================================================================
 * DÓNDE SE ENGANCHA, Y POR QUÉ AHÍ Y NO EN EL ESQUEMA
 * ===========================================================================
 * La tentación es envolver el esquema en un `z.preprocess`. Sería peor: la SDK
 * convierte el esquema de Zod a JSON Schema para MANDÁRSELO al modelo, y un
 * `ZodEffects` no traduce — el modelo recibiría un esquema vacío y perderíamos
 * lo único que hoy funciona, que es la descripción de los campos.
 *
 * La SDK tiene una costura para esto: `experimental_repairText`, que sólo se
 * invoca DESPUÉS de que el parseo o la validación fallaron, recibe el texto tal
 * cual y devuelve texto reparado o `null`. No toca el cuerpo de la petición, no
 * toca el esquema, y cuando no puede hacer nada devuelve `null` y el error
 * original sigue su camino. Es exactamente la forma de este problema.
 *
 * Medido con el reparador puesto: 6/6 recuperadas en las dos configuraciones,
 * cero pérdidas.
 */

/** Cuántas capas de envoltorio se deshacen antes de rendirse. */
const MAX_HOPS = 3;

/**
 * Deshace los envoltorios que el modelo pone de más.
 *
 * Dos movimientos, y sólo se aplican cuando MEJORAN algo:
 *
 *   UNA CADENA QUE ES JSON se convierte en lo que representa. Es el caso
 *   medido: la propiedad trae el objeto serializado en vez del objeto.
 *
 *   UN OBJETO ANIDADO BAJO SU PROPIA CLAVE se aplana: `{tasks:{tasks:[…]}}` es
 *   `{tasks:[…]}`. Aparece cuando el modelo serializa la respuesta completa
 *   dentro del primer campo, que es la misma equivocación vista desde fuera.
 *
 * El tope de saltos no es adorno: la entrada la escribió un modelo, y un
 * `while` sin freno sobre datos ajenos es un cuelgue esperando a que alguien lo
 * encuentre en producción.
 */
export function unwrapNesting(value: unknown, key: string): unknown {
  let current = value;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (typeof current === 'string') {
      const trimmed = current.trim();
      // Sólo se intenta si parece JSON. Una cadena que de verdad era una cadena
      // —un título, una instrucción— no se puede tocar: parsearla la
      // destruiría, y este reparador no puede permitirse dañar lo que ya venía
      // bien.
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return current;
      try {
        current = JSON.parse(trimmed);
        continue;
      } catch {
        return current;
      }
    }
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      key in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return current;
  }
  return current;
}

/**
 * El texto reparado, o `null` si no había nada que arreglar o no se pudo.
 *
 * Devolver `null` importa tanto como reparar: le dice a la SDK que levante el
 * error original en vez de uno nuevo y peor, y evita que un fallo distinto —el
 * modelo contestó de verdad en prosa, el JSON venía cortado— se disfrace de
 * éxito a medias.
 *
 * `expectedKeys` son las propiedades de primer nivel del esquema. Se piden en
 * vez de deducirse porque el reparador tiene que saber QUÉ envoltorio sobra: sin
 * esa lista, un objeto legítimo con una sola clave sería indistinguible de uno
 * mal envuelto.
 */
export function repairStructuredText(text: string, expectedKeys: readonly string[]): string | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    // La herramienta forzada casi siempre entrega JSON válido; si esto falla, el
    // modelo escribió prosa de verdad y eso no es cosa de este reparador.
    return null;
  }

  // El envoltorio de fuera: todo el objeto serializado como cadena.
  if (typeof root === 'string') {
    const inner = unwrapNesting(root, expectedKeys[0] ?? '');
    if (inner === root) return null;
    root = inner;
  }

  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;

  const source = root as Record<string, unknown>;
  const repaired: Record<string, unknown> = { ...source };
  let changed = false;

  for (const key of expectedKeys) {
    if (!(key in source)) continue;
    const fixed = unwrapNesting(source[key], key);
    if (fixed !== source[key]) {
      repaired[key] = fixed;
      changed = true;
    }
  }

  // Un objeto que sólo trae una clave y dentro tiene las que se esperaban:
  // `{"tasks": {"tasks": …}}` ya lo cubre el bucle, pero
  // `{"result": {"tasks": …}}` no, y es la misma equivocación con otro nombre.
  if (!changed) {
    const keys = Object.keys(source);
    const only = keys.length === 1 ? source[keys[0] as string] : null;
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      const inner = only as Record<string, unknown>;
      if (expectedKeys.some((k) => k in inner)) return JSON.stringify(inner);
    }
    return null;
  }

  return JSON.stringify(repaired);
}

/**
 * El reparador, con la forma que `experimental_repairText` espera.
 *
 * Se le pasan las claves de primer nivel del esquema:
 *
 *     experimental_repairText: repairStructured(['tasks'])
 */
export function repairStructured(expectedKeys: readonly string[]) {
  return async ({ text }: { text: string }): Promise<string | null> =>
    repairStructuredText(text, expectedKeys);
}
