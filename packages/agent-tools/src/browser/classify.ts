import type { FailureEvidence, FailureKind, PageSnapshot, Step } from './types';

/**
 * "The site changed" versus "the errand failed" -- the decision that determines
 * whether this library is still worth anything in six months.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE DANGEROUS QUESTION
 * ---------------------------------------------------------------------------
 * Repair asks a model to look at a page and find the element that moved. Point
 * it at the wrong page and it will find something -- models are obliging. Ask
 * it to repair a step against an outage page and it will invent a selector for
 * the outage page; against "esa placa no existe" it will bind the step to the
 * error banner. Either way the flow is then WRONG AND MARKED FIXED, which is
 * strictly worse than broken, because broken is visible.
 *
 * So the asymmetry is built in: `site-changed` is the only verdict that lets a
 * model touch a flow, and it requires POSITIVE EVIDENCE. Everything ambiguous
 * falls to `transient`, whose consequence is a retry -- free, reversible, and
 * wrong at worst by a minute.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY EACH RULE SITS WHERE IT DOES
 * ---------------------------------------------------------------------------
 *  1  the page never arrived            transient   nothing to read, nothing to fix
 *  2  5xx / 429                         transient   their server, not our flow
 *  3  maintenance or back-off wording   transient   the site said so itself
 *  4  a refusal we recognise            legitimate  the errand was answered, with no
 *  5  401 / 403                         legitimate  a credential problem, not a layout one
 *  6  we are staring at a login form    legitimate  THE IMPORTANT ONE -- see below
 *  7  404 on a navigation               site-changed  our stored URL no longer exists
 *  8  the element is there but blocked  transient   the selector was right; something
 *                                                   was covering it or still loading
 *  9  landmarks gone                    site-changed  this is not the page we learned
 * 10  element missing, page healthy     site-changed  one control moved
 * 11  anything else                     transient
 *
 * RULE 6 IS THE ONE THAT PREVENTS THE WORST OUTCOME. An expired session
 * redirects to a login page. A login page has none of the flow's landmarks and
 * none of the flow's elements, so rules 9 and 10 would both shout
 * "site-changed" and hand a model a login form to rewrite the flow against. The
 * flow would then be permanently rewritten to log in at step 4 of an errand,
 * and it would look repaired. A password field on the page, when the failing
 * step was not itself part of logging in, is unambiguous: we are logged out.
 */

/** Said by the site about itself. Retry; never repair. */
const BACKOFF_PHRASES = [
  'en mantenimiento',
  'fuera de servicio',
  'no disponible temporalmente',
  'temporalmente no disponible',
  'intente mas tarde',
  'intente nuevamente mas tarde',
  'vuelva a intentar en unos minutos',
  'servicio no disponible',
  'under maintenance',
  'temporarily unavailable',
  'service unavailable',
  'too many requests',
  'demasiadas solicitudes',
];

/**
 * The errand was heard and refused. The flow is fine and must not be touched.
 *
 * Colombian portals first, because that is who this runs against. Kept as
 * accent-insensitive fragments -- these strings are compared against text that
 * has been lowercased and stripped of diacritics, so "sesión" and "sesion",
 * "contraseña" and "contrasena" all land on the same entry.
 */
const REFUSAL_PHRASES = [
  // nothing there
  'no se encontro',
  'no se encontraron',
  'no existe',
  'no hay registro',
  'no registra informacion',
  'sin resultados',
  'no se hallaron',
  'no fue posible encontrar',
  'no aparece registrado',
  'placa no registrada',
  'documento no encontrado',
  'no results found',
  'no records found',
  // the login was refused
  'usuario o contrasena',
  'contrasena incorrecta',
  'clave incorrecta',
  'credenciales invalidas',
  'credenciales incorrectas',
  'datos de acceso incorrectos',
  'acceso denegado',
  'no autorizado',
  'invalid credentials',
  'incorrect password',
  'login failed',
  // the session went away
  'su sesion ha expirado',
  'sesion expirada',
  'la sesion ha finalizado',
  'debe iniciar sesion',
  'vuelva a iniciar sesion',
  'session expired',
  'session has expired',
  'please log in',
  // the form said no
  'campo obligatorio',
  'campos obligatorios',
  'dato invalido',
  'datos invalidos',
  'formato incorrecto',
  'debe ingresar',
  'verifique los datos',
  'el codigo ingresado no es valido',
  'captcha incorrecto',
  'validation failed',
];

/** Words that mean the failing step was itself part of signing in. */
const LOGIN_STEP_WORDS = [
  'contrasena',
  'clave',
  'password',
  'usuario',
  'iniciar sesion',
  'ingresar',
  'login',
  'sign in',
  'acceder',
];

/**
 * Lowercase and strip diacritics, so one phrase in the lists above matches both
 * the accented and unaccented spellings a portal might use -- and matches text
 * copied out of a PDF, where the accents are often already gone.
 */
export function normalize(text: string): string {
  return (
    text
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the intent
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  );
}

function containsAny(haystack: string, needles: string[]): string | null {
  for (const needle of needles) {
    if (haystack.includes(needle)) return needle;
  }
  return null;
}

export interface Classification {
  kind: FailureKind;
  /** One sentence, in Spanish, for the screen and for the run row. */
  reason: string;
  /** Which rule fired. Read by the tests, and by whoever debugs this later. */
  rule: string;
}

export function classifyFailure(input: {
  evidence: FailureEvidence;
  snapshot: PageSnapshot;
  step: Step;
}): Classification {
  const { evidence, snapshot, step } = input;
  const text = normalize(`${evidence.alertText ?? ''} ${evidence.bodyTextSample}`);

  // 1. Nothing arrived. There is no page to read and nothing about the flow to
  //    conclude, so the only safe verdict is "try again".
  if (evidence.navigationFailed || (evidence.timedOut && snapshot.elements.length === 0)) {
    return {
      kind: 'transient',
      rule: 'no-page',
      reason: 'El sitio no respondió. No cambié nada del trámite; vale la pena reintentar.',
    };
  }

  // 2. Their server. Repairing a flow against a 502 is how a working flow dies.
  if (evidence.httpStatus !== null && evidence.httpStatus >= 500) {
    return {
      kind: 'transient',
      rule: 'server-error',
      reason: `El sitio devolvió un error ${evidence.httpStatus}. Es de ellos, no del trámite.`,
    };
  }
  if (evidence.httpStatus === 429) {
    return {
      kind: 'transient',
      rule: 'rate-limited',
      reason: 'El sitio nos está limitando por exceso de consultas. Hay que esperar un rato.',
    };
  }

  // 3. The site said "not now" in its own words.
  const backoff = containsAny(text, BACKOFF_PHRASES);
  if (backoff) {
    return {
      kind: 'transient',
      rule: 'site-says-later',
      reason: 'El portal dice que está fuera de servicio o pide reintentar más tarde.',
    };
  }

  // 4. A refusal we recognise. The errand was answered; the answer was no.
  const refusal = containsAny(text, REFUSAL_PHRASES);
  if (refusal) {
    return {
      kind: 'legitimate',
      rule: 'refusal-text',
      reason: `El portal respondió y rechazó el trámite («${refusal}»). El flujo está bien; el dato o la sesión, no.`,
    };
  }

  // 5. Turned away at the door.
  if (evidence.httpStatus === 401 || evidence.httpStatus === 403) {
    return {
      kind: 'legitimate',
      rule: 'http-auth',
      reason: `El sitio respondió ${evidence.httpStatus}: es un problema de credenciales o de sesión, no del trámite.`,
    };
  }

  // 6. The login-page guard. See the header note -- this is the rule that stops
  //    an expired session from getting a good flow rewritten against a login
  //    form and stamped "repaired".
  const passwordOnPage = snapshot.elements.some(
    (el) => (el.type ?? '').toLowerCase() === 'password',
  );
  const stepIsLogin = containsAny(
    normalize(`${step.label} ${step.value?.kind === 'secret' ? step.value.field : ''}`),
    LOGIN_STEP_WORDS,
  );
  if (passwordOnPage && !stepIsLogin) {
    return {
      kind: 'legitimate',
      rule: 'bounced-to-login',
      reason:
        'Terminamos en una pantalla de inicio de sesión: la sesión se venció o la credencial ya no sirve. No toqué el flujo.',
    };
  }

  // 7. The address we stored is gone. That IS the site changing, and it is the
  //    one 4xx that says so -- a portal answering "no existe ese vehículo"
  //    serves a 200 page with words on it, which rule 4 already caught.
  if (evidence.httpStatus === 404) {
    return {
      kind: 'site-changed',
      rule: 'url-gone',
      reason: 'La dirección que tenía guardada ya no existe en ese portal.',
    };
  }

  // 8. We found it and could not use it. The selector was right, so there is
  //    nothing for a model to fix -- something was on top of it, or the page
  //    was still settling.
  if (evidence.visibleButBlocked) {
    return {
      kind: 'transient',
      rule: 'blocked',
      reason:
        'Encontré el elemento pero no pude usarlo — algo lo estaba tapando o la página no había terminado de cargar.',
    };
  }

  // 9. Not the page we learned on.
  if (evidence.landmarksExpected >= 2) {
    const ratio = evidence.landmarksPresent / evidence.landmarksExpected;
    if (ratio < 0.5) {
      return {
        kind: 'site-changed',
        rule: 'landmarks-gone',
        reason: `La página ya no se parece a la que aprendí (quedan ${evidence.landmarksPresent} de ${evidence.landmarksExpected} referencias).`,
      };
    }
  }

  // 10. The page is the page, it loaded fine, nobody refused anything, and the
  //     control is not there under any of the ways we know to look for it. That
  //     is a redesign, and it is the case repair exists for.
  const noneMatched =
    evidence.candidates.length > 0 && evidence.candidates.every((c) => c.matches === 0);
  if (noneMatched && (evidence.httpStatus === null || evidence.httpStatus < 400)) {
    return {
      kind: 'site-changed',
      rule: 'element-moved',
      reason: `«${step.label}» ya no está donde estaba y ninguna de las formas guardadas de encontrarlo funciona.`,
    };
  }

  // 11. Unclassified. Retry rather than guess -- the cost of a needless retry
  //     is a minute, the cost of a needless repair is a corrupted flow.
  return {
    kind: 'transient',
    rule: 'unknown',
    reason: 'Falló y no pude establecer por qué, así que no cambié nada del trámite.',
  };
}
