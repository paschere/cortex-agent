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
 *  0  a login page, and this flow has   needs-login not a failure: a question
 *     no login in it at all
 *  1  the page never arrived            transient   nothing to read, nothing to fix
 *  2  5xx / 429                         transient   their server, not our flow
 *  3  maintenance or back-off wording   transient   the site said so itself
 *  4  a refusal we recognise            legitimate  the errand was answered, with no
 *  5  401 / 403                         legitimate  a credential problem, not a layout one
 *  6  we are staring at a login form    legitimate  THE IMPORTANT ONE -- see below
 *  7  404 on a navigation               site-changed  our stored URL no longer exists
 *  8a several things match             site-changed  the description is not specific
 *                                                   enough for this page
 *  8b the element is there but blocked  transient   the selector was right; something
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

/**
 * Said by a page that is checking whether a human is driving.
 *
 * NOT a bare "captcha": "captcha incorrecto" means somebody typed one wrong,
 * which is an ordinary refusal and belongs to rule 4. Every entry here is a
 * phrase that only appears when the challenge is being POSED.
 *
 * Accent-free, because they are compared against normalised text.
 */
const CHALLENGE_PHRASES = [
  // Google's /sorry page, verbatim in both languages
  'trafico inusual',
  'unusual traffic',
  'en lugar de un robot',
  'rather than a robot',
  'sistemas han detectado trafico',
  // reCAPTCHA / hCaptcha, as they present themselves
  'no soy un robot',
  'not a robot',
  'verificar que eres humano',
  'verifica que eres humano',
  'confirma que eres humano',
  'verify you are human',
  'verifying you are human',
  'are you a human',
  // Cloudflare and friends
  'checking your browser',
  'comprobando tu navegador',
  'ddos protection by',
  'needs to review the security of your connection',
  'revisar la seguridad de tu conexion',
  // generic, but only in the posing form
  'complete the security check',
  'completa la verificacion de seguridad',
  'prueba de que no eres un robot',
];

/**
 * Paths that ARE the challenge, whatever the page says.
 *
 * Kept beside the phrases because a challenge served in an iframe, in a
 * language we do not list, or as an image with no text at all would otherwise
 * read as "the page went blank" — and that is the reading that costs a repair.
 */
const CHALLENGE_PATHS = ['/sorry/', '/cdn-cgi/challenge', '__cf_chl', '/challenge-platform'];

/** Which signal fired, or null. The name goes in the rule, so it is debuggable. */
function challengeSignal(evidence: FailureEvidence, normalisedText: string): string | null {
  if ((evidence.challengeFrames ?? 0) > 0) return 'widget';
  const url = normalize(evidence.url ?? '');
  if (CHALLENGE_PATHS.some((p) => url.includes(p))) return 'url';
  const phrase = containsAny(normalisedText, CHALLENGE_PHRASES);
  if (phrase) return 'text';
  // The title is checked separately and last: Google's /sorry page puts the
  // ORIGINAL search URL in its <title>, so the title alone is weak evidence —
  // but a page titled "Just a moment…" with nothing else to go on is not.
  const title = normalize(evidence.pageTitle ?? '');
  if (title === 'just a moment...' || title === 'un momento...') return 'title';
  return null;
}

export interface Classification {
  kind: FailureKind;
  /** One sentence, in Spanish, for the screen and for the run row. */
  reason: string;
  /** Which rule fired. Read by the tests, and by whoever debugs this later. */
  rule: string;
}

/**
 * Whether this flow is even capable of opening the door it is standing at.
 *
 * A flow that carries login steps and a bound credential and STILL lands on a
 * login form has had its credential rejected or its session cut -- an ordinary
 * refusal, and the flow is fine. A flow with no login steps at all has never
 * been taught to log in: it was recorded by somebody who was already inside,
 * and it was never going to work from a clean browser. Those are different
 * situations with different answers, and telling them apart needs one fact
 * about the flow that the failing step does not carry.
 *
 * Omitted, it defaults to the old behaviour -- assume the flow can log in, and
 * call a login page a legitimate refusal.
 */
export interface FlowLoginFacts {
  /** A credential is bound, so a login step would have something to type. */
  hasCredential: boolean;
  /** The step list contains a login: a password field is filled somewhere. */
  hasLoginSteps: boolean;
}

/** Does any step in this flow type a credential? */
export function hasLoginSteps(steps: Step[]): boolean {
  return steps.some(
    (s) =>
      s.value?.kind === 'secret' ||
      containsAny(normalize(`${s.label} ${s.targets.map((t) => t.value).join(' ')}`), [
        'contrasena',
        'password',
        'clave',
      ]) !== null,
  );
}

export function classifyFailure(input: {
  evidence: FailureEvidence;
  snapshot: PageSnapshot;
  step: Step;
  flow?: FlowLoginFacts;
}): Classification {
  const { evidence, snapshot, step } = input;
  const text = normalize(`${evidence.alertText ?? ''} ${evidence.bodyTextSample}`);

  // 0. THE DOOR NOBODY RECORDED.
  //
  //    This sits above everything because of what it is competing with: a login
  //    page says "debe iniciar sesión", which rule 4 reads as the portal
  //    refusing the errand. That reading is right when the flow TRIED to log in
  //    and was turned away, and wrong when the flow never had a login in it --
  //    in which case nothing was refused, we simply arrived at a door with no
  //    key and no instructions for opening it.
  //
  //    The difference matters because the answers are opposite. A refusal is
  //    over: fix the data. A missing login is a QUESTION -- which account, and
  //    would you record the way in -- and it is answerable, by a person, once.
  //    Filing it as a failure is how a trámite ends up marked broken for a
  //    reason nobody can act on.
  //
  //    Guarded twice: the failing step must not itself be a login step, and the
  //    flow must contain no login at all. Both together mean this flow was
  //    taught from inside a session it does not know how to create.
  const passwordOnPage = snapshot.elements.some(
    (el) => (el.type ?? '').toLowerCase() === 'password',
  );
  const stepIsLogin =
    containsAny(
      normalize(`${step.label} ${step.value?.kind === 'secret' ? step.value.field : ''}`),
      LOGIN_STEP_WORDS,
    ) !== null;

  if (passwordOnPage && !stepIsLogin && input.flow && !input.flow.hasLoginSteps) {
    return {
      kind: 'needs-login',
      rule: 'login-never-taught',
      reason:
        'Este trámite empieza dentro de una sesión: quien lo enseñó ya estaba adentro, así que la grabación nunca mostró el ingreso. Desde un navegador limpio caemos en la pantalla de acceso y no hay con qué entrar.',
    };
  }

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

  // 3b. THE PORTAL STOPPED TO ASK WHETHER WE ARE A PERSON.
  //
  //     This rule exists because of what happened without it, which is the most
  //     expensive shape of bug this module can have. Google answers an
  //     automated browser with /sorry/index -- a verification page carrying
  //     none of the flow's elements. Every stored candidate then reports zero
  //     matches, which is EXACTLY the signature rule 10 reads as "the site was
  //     redesigned". So a flow that was never broken got filed as
  //     `site-changed`, which is the one verdict that lets a model rewrite it:
  //     Cortex paid for a repair against a captcha page, the repair could not
  //     help, and the next run did it again. Forever.
  //
  //     Reproduced before writing this: chromium at google.com, fill the search
  //     box, press Enter, and the page becomes /sorry/index with
  //     `combobox[Buscar]` at zero matches and two captcha nodes.
  //
  //     It sits above rule 4 so a challenge is not mistaken for a refusal, and
  //     below rule 3 so a site that says "vuelva más tarde" is still believed.
  //     The phrases are deliberately narrow -- no bare "captcha", because
  //     "captcha incorrecto" means somebody typed one wrong, which IS an
  //     ordinary refusal and belongs to rule 4.
  const challenge = challengeSignal(evidence, text);
  if (challenge) {
    return {
      kind: 'needs-human',
      rule: `bot-check:${challenge}`,
      reason:
        'El portal se detuvo a comprobar que no somos un robot. El trámite está bien y no toqué nada: ' +
        'hace falta que una persona resuelva la verificación.',
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
  //    form and stamped "repaired". Rule 0 has already taken the flows that
  //    never knew how to log in; what reaches here tried and was turned away.
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

  // 8a. SEVERAL things answer to the same description.
  //
  //     This looks like rule 8 and is its opposite. `resolveTarget` takes a
  //     candidate only when it matches EXACTLY ONE visible element, so a
  //     candidate reporting two or more matches did not fail to find anything --
  //     it found a crowd, and refused to guess which one. That is not a
  //     transient condition and no retry will change it: the description the
  //     step carries is simply not specific enough for this page, which is
  //     precisely what a repair is for.
  //
  //     The case that produces it is a results table -- five rows, five links
  //     that all read "Ver detalle", told apart only by an `aria-label` that no
  //     recording could show. Before this rule the run was filed as
  //     `transient/blocked` and retried forever against a page that would never
  //     answer differently.
  const ambiguous = evidence.candidates.filter((c) => c.matches > 1);
  if (ambiguous.length > 0) {
    const worst = ambiguous.reduce((a, b) => (b.matches > a.matches ? b : a));
    return {
      kind: 'site-changed',
      rule: 'ambiguous',
      reason: `«${step.label}» no se puede señalar sin ambigüedad: en la página hay ${worst.matches} elementos que responden a la misma descripción. Actuar sobre uno al azar no es una opción.`,
    };
  }

  // 8b. We found it and could not use it. Exactly one match, so the selector
  //     was right and there is nothing for a model to fix -- something was on
  //     top of it, or the page was still settling.
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
