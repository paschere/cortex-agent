import type { ProposedStep } from './browser-shape';

/**
 * ¿Este trámite necesita una cuenta, y hay que preguntarla AHORA?
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ ESTA PREGUNTA NO PUEDE ESPERAR
 * ---------------------------------------------------------------------------
 * Un trámite al que le falta la cuenta no se rompe el día que se enseña: se
 * rompe la primera madrugada en que alguien lo programó y nadie lo estaba
 * mirando. Para entonces la pregunta «¿con qué usuario entraste?» ya no tiene
 * a quién hacérsela — quien grabó no se acuerda, o ya no está — y lo que era
 * una casilla de texto se volvió un ticket de soporte.
 *
 * La persona que acaba de grabar es la única que sabe la respuesta y es la
 * única que la tiene en la cabeza en ese instante. Este módulo existe para
 * detectar el caso mientras esa persona sigue en la pantalla.
 *
 * ---------------------------------------------------------------------------
 * DOS SEÑALES, Y LA SEGUNDA ES LA IMPORTANTE
 * ---------------------------------------------------------------------------
 * (a) LA GRABACIÓN TIENE UN INGRESO. Hay un paso con un campo de credencial
 *     (`value.kind === 'secret'`) o rotulado con «contraseña», «clave» o
 *     «password». Es la señal fácil: se ve, y no hay ambigüedad.
 *
 * (b) LA GRABACIÓN NO TIENE INGRESO Y AUN ASÍ HACE FALTA. Éste es el caso
 *     caro, y es el que describe la regla 0 de `classify.ts`
 *     (`login-never-taught`): quien grabó ya estaba adentro del portal, así
 *     que la grabación nunca mostró la puerta. Desde un navegador limpio el
 *     trámite cae en la pantalla de acceso y no hay con qué entrar. No se ve
 *     en los pasos — precisamente porque el paso que falta es el que nadie
 *     grabó — así que hay que deducirlo de la dirección: un portal que sólo
 *     existe detrás de una sesión, un identificador de sesión metido en la
 *     URL, una zona privada del sitio.
 *
 * Y una tercera, que no es una deducción sino un hecho: la corrida de
 * verificación terminó en una pantalla de acceso y el motor lo clasificó como
 * `needs-login`. Cuando eso llega, no hay nada que adivinar.
 *
 * ---------------------------------------------------------------------------
 * LA DIFERENCIA QUE HAY QUE DECIR EN VOZ ALTA
 * ---------------------------------------------------------------------------
 * En el caso (b) guardar la clave NO ARREGLA el trámite, y prometer lo
 * contrario sería la peor forma de fallar aquí. El motor sólo escribe una
 * credencial en los pasos que la piden (`secrets[value.field]` en el servicio
 * de navegador); si la grabación no tiene esos pasos, la clave queda guardada
 * y sin usar, y la siguiente corrida vuelve a estrellarse contra la misma
 * puerta. Por eso `loginNeverTaught` viaja hasta la interfaz: la cuenta se
 * guarda igual —va a hacer falta— pero la pantalla dice, sin rodeos, que hay
 * que volver a grabar el trámite cerrando sesión primero.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ ESTÁ COPIADO AQUÍ Y NO IMPORTADO
 * ---------------------------------------------------------------------------
 * `recordingHasLogin` es un espejo de `hasLoginSteps` de
 * `packages/agent-tools/src/browser/classify.ts`. Importar el barril desde un
 * componente `'use client'` arrastra `node:dns` al bundle del navegador y
 * rompe el build de producción sin que typecheck ni los tests digan nada — el
 * mismo muro que documenta `browser-shape.ts`. La copia se paga con
 * `browser-login.test.ts`, que corre en Node, importa la función real y falla
 * en cuanto las dos dejen de estar de acuerdo.
 */

/** Minúsculas y sin tildes, para que «contraseña» y «contrasena» sean lo mismo. */
function fold(text: string): string {
  return (
    text
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: quitar los diacríticos es la intención
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  );
}

/** Las mismas tres palabras que busca `hasLoginSteps`. No se tocan por separado. */
const LOGIN_WORDS = ['contrasena', 'password', 'clave'];

/**
 * ¿Algún paso de esta grabación escribe una credencial?
 *
 * Espejo exacto de `hasLoginSteps`. Cualquier cambio aquí sin el equivalente
 * allá lo caza el test.
 */
export function recordingHasLogin(steps: ProposedStep[]): boolean {
  return steps.some(
    (s) =>
      s.value?.kind === 'secret' ||
      LOGIN_WORDS.some((word) =>
        fold(`${s.label} ${s.targets.map((t) => t.value).join(' ')}`).includes(word),
      ),
  );
}

/**
 * Los nombres de campo que los pasos van a buscar dentro de la credencial.
 *
 * No son decorativos: el servicio de navegador resuelve un paso secreto como
 * `secrets[value.field]`, así que si el formulario guarda «password» y el paso
 * pide «clave», el trámite teclea una cadena vacía y el portal lo rechaza sin
 * que nadie entienda por qué. Se leen de los pasos, en orden y sin repetir.
 *
 * Cuando no hay pasos secretos —el caso (b)— no hay nada que leer, y los dos
 * nombres de abajo son los que produce `fieldNameFor` para los rótulos más
 * comunes de un portal en español.
 */
export function secretFieldNames(steps: ProposedStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (step.value?.kind !== 'secret') continue;
    const field = step.value.field.trim();
    if (field && !names.includes(field)) names.push(field);
  }
  return names.length > 0 ? names : ['usuario', 'clave'];
}

/** La dirección reducida al origen al que pertenece una credencial. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Portales que no existen fuera de una sesión.
 *
 * La lista es corta a propósito. Cada entrada está aquí porque el sitio ENTERO
 * vive detrás de un ingreso, no porque «suene corporativo»: preguntar de más
 * en un portal público —una consulta de placa, un RUT— es exactamente el ruido
 * que hace que la gente deje de leer los avisos. Cuando hay duda, la respuesta
 * correcta es no estar en esta lista y dejar que la corrida de verificación
 * conteste, que para eso existe.
 *
 * Se compara por sufijo registrable, así que `www.` y los subdominios entran y
 * `nodian.gov.co` no.
 */
const SESSION_ONLY_PORTALS: { suffixes: string[]; name: string }[] = [
  { suffixes: ['muisca.dian.gov.co'], name: 'el MUISCA de la DIAN' },
  { suffixes: ['community.secop.gov.co'], name: 'SECOP II' },
  { suffixes: ['siigo.com', 'siigonube.com'], name: 'Siigo' },
  { suffixes: ['worldoffice.cloud'], name: 'World Office' },
  { suffixes: ['alegra.com'], name: 'Alegra' },
  { suffixes: ['salesforce.com', 'force.com'], name: 'Salesforce' },
  { suffixes: ['atlassian.net'], name: 'Atlassian' },
  { suffixes: ['zoho.com', 'zoho.eu'], name: 'Zoho' },
  { suffixes: ['odoo.com'], name: 'Odoo' },
  { suffixes: ['netsuite.com'], name: 'NetSuite' },
  { suffixes: ['successfactors.com', 'sapsf.com'], name: 'SAP SuccessFactors' },
  { suffixes: ['myshopify.com'], name: 'Shopify' },
];

/** El portal de sesión al que apunta esta dirección, si es uno de los conocidos. */
export function sessionOnlyPortal(startUrl: string): string | null {
  let host: string;
  try {
    host = new URL(startUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const entry of SESSION_ONLY_PORTALS) {
    for (const suffix of entry.suffixes) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return entry.name;
    }
  }
  return null;
}

/**
 * Un identificador de sesión dentro de la propia dirección.
 *
 * Es la prueba más limpia que existe de que la grabación empezó adentro: un
 * `;jsessionid=…` o un `?sid=…` no aparece en una página pública, lo pone el
 * servidor cuando ya hay una sesión abierta. Y encima es una dirección que
 * mañana no sirve, porque esa sesión se venció — así que decirlo ahora ahorra
 * dos problemas.
 */
/**
 * Anclado a un delimitador (`?`, `&` o el `;` de los parámetros de ruta de
 * Java) para no confundirse con una consulta que legítimamente se llame
 * `?consultaid=` o `?basid=`. Un falso positivo aquí manda a alguien a buscar
 * una contraseña que no hace falta.
 */
const SESSION_IN_URL = /[?&;](jsessionid|phpsessid|sessionid|session_id|sid|asp\.net_sessionid)=/i;

export function sessionIdInUrl(startUrl: string): boolean {
  return SESSION_IN_URL.test(startUrl);
}

/**
 * Zonas que un portal reserva para quien ya entró.
 *
 * Más débil que las dos señales anteriores, y por eso `certain: false`: son
 * convenciones, no hechos. Pero son las convenciones que usan justo los
 * sistemas que este módulo tiene enfrente —la oficina virtual, el portal del
 * cliente, la intranet del operador— y equivocarse aquí sólo cuesta una
 * pregunta de más que se puede saltar con un clic.
 */
const PRIVATE_HOST_LABELS = [
  'portal',
  'mi',
  'micuenta',
  'clientes',
  'cliente',
  'intranet',
  'secure',
  'seguro',
  'oficinavirtual',
  'sucursalvirtual',
  'autogestion',
  'sedeelectronica',
];

const PRIVATE_PATH_PARTS = [
  '/portal/',
  '/intranet/',
  '/micuenta',
  '/mi-cuenta',
  '/oficina-virtual',
  '/oficinavirtual',
  '/sucursal-virtual',
  '/autogestion',
  '/dashboard',
  '/panel/',
  '/privado',
  '/private/',
  '/secure/',
];

/** Cómo se llama la zona privada que reconocimos, o `null`. */
export function privateArea(startUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return null;
  }
  const label = fold(url.hostname).split('.')[0] ?? '';
  if (PRIVATE_HOST_LABELS.includes(label)) return `${label}.`;

  const path = `${fold(url.pathname)}/`;
  for (const part of PRIVATE_PATH_PARTS) {
    if (path.includes(part)) return part;
  }
  return null;
}

export type AccountSignal =
  | 'grabacion'
  | 'verificacion'
  | 'portal-de-sesion'
  | 'sesion-en-la-url'
  | 'zona-privada';

export interface AccountNeed {
  /** ¿Hay que pedir la cuenta? */
  needed: boolean;
  /** Cuál señal disparó. Va en el informe y en los tests, no en la pantalla. */
  signal: AccountSignal | null;
  /** `true` = lo vimos. `false` = es muy probable, y por eso se pregunta. */
  certain: boolean;
  /**
   * La grabación no contiene el ingreso. Guardar la clave no basta: hay que
   * volver a enseñar el trámite cerrando sesión primero. Ver la regla 0 de
   * `classify.ts`.
   */
  loginNeverTaught: boolean;
  /** Titular, en una línea. */
  title: string;
  /** Por qué lo decimos, en una frase que se pueda contradecir. */
  reason: string;
  /** Los campos que hay que pedir, con los nombres que los pasos van a buscar. */
  fields: string[];
}

const NO_NEED: AccountNeed = {
  needed: false,
  signal: null,
  certain: false,
  loginNeverTaught: false,
  title: '',
  reason: '',
  fields: [],
};

/**
 * El veredicto, con su motivo, para una grabación recién leída o para un
 * trámite que ya existe.
 *
 * El orden es deliberado. La verificación va primero porque no es una
 * deducción: es el portal contestando. Después la grabación, que es un hecho
 * de los pasos. Y sólo al final las tres pistas de la dirección, de la más
 * fuerte a la más débil, ninguna de las cuales se presenta como certeza.
 */
export function describeAccountNeed(input: {
  steps: ProposedStep[];
  startUrl: string;
  /** El motor clasificó la última corrida como `needs-login`. */
  verificationSaidLogin?: boolean;
}): AccountNeed {
  const { steps, startUrl } = input;
  const hasLogin = recordingHasLogin(steps);
  const fields = secretFieldNames(steps);
  const site = originOf(startUrl) || 'ese portal';

  if (input.verificationSaidLogin) {
    return {
      needed: true,
      signal: 'verificacion',
      certain: true,
      loginNeverTaught: !hasLogin,
      title: 'Al probarlo terminamos en la pantalla de acceso',
      reason: hasLogin
        ? `Lo corrí contra ${site} y el portal volvió a pedir el ingreso. Necesita una cuenta guardada para poder entrar solo.`
        : `Lo corrí contra ${site} y el portal pidió iniciar sesión. La grabación arrancó cuando ya estabas adentro, así que nunca mostró la puerta.`,
      fields,
    };
  }

  if (hasLogin) {
    return {
      needed: true,
      signal: 'grabacion',
      certain: true,
      loginNeverTaught: false,
      title: 'Este trámite inicia sesión',
      reason:
        'En la grabación hay un campo de contraseña. No guardé lo que tecleaste —eso nunca se transcribe—, así que el trámite tiene el hueco del ingreso y no puede correr hasta que le vincules la cuenta.',
      fields,
    };
  }

  const portal = sessionOnlyPortal(startUrl);
  if (portal) {
    return {
      needed: true,
      signal: 'portal-de-sesion',
      certain: false,
      loginNeverTaught: true,
      title: `${portal} siempre pide iniciar sesión`,
      reason: `Grabaste dentro de ${portal}, que no se puede abrir sin cuenta, y en la grabación no quedó el ingreso: la hiciste con la sesión ya abierta. Desde un navegador limpio esto cae en la pantalla de acceso.`,
      fields,
    };
  }

  if (sessionIdInUrl(startUrl)) {
    return {
      needed: true,
      signal: 'sesion-en-la-url',
      certain: false,
      loginNeverTaught: true,
      title: 'La dirección que grabaste lleva una sesión adentro',
      reason:
        'La URL trae un identificador de sesión, que es algo que sólo aparece cuando ya entraste. Esa dirección se vence con la sesión, así que este trámite va a necesitar la cuenta para abrirse la próxima vez.',
      fields,
    };
  }

  const area = privateArea(startUrl);
  if (area) {
    return {
      needed: true,
      signal: 'zona-privada',
      certain: false,
      loginNeverTaught: true,
      title: 'Esto parece la zona privada del portal',
      reason: `La dirección apunta a «${area}», que en casi todos los portales es la parte que sólo se ve con la sesión abierta. Si me equivoco, sáltate esto y sigue.`,
      fields,
    };
  }

  return NO_NEED;
}
