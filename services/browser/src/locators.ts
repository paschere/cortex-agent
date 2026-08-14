import type { Locator, Page } from 'playwright';
import type { Target } from './types';

/**
 * A stored target, turned back into something Playwright can find.
 *
 * Every branch here except `css` resolves by MEANING -- the element's role and
 * accessible name, the label beside it, the placeholder inside it, the form
 * field name the server gave it. That is the property the whole module rests
 * on: a portal can be restyled, rebuilt in another framework or reflowed for
 * mobile, and the button that said "Consultar" still says "Consultar".
 */
/**
 * Dónde se busca un elemento: el documento, o uno de sus marcos.
 *
 * `Page` y `Frame` comparten toda la API de localización, así que el resto del
 * archivo no distingue entre los dos.
 */
type Searchable = Pick<
  Page,
  'getByTestId' | 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator'
>;

export function buildLocator(page: Searchable, target: Target): Locator {
  switch (target.kind) {
    case 'testid':
      return page.getByTestId(target.value);
    case 'role':
      // `exact: false` on purpose: portals pad accessible names with
      // whitespace, icons and counts ("Consultar (3)"), and an exact match
      // would fail on a change that no person would call a change.
      return target.name
        ? page.getByRole(target.value as Parameters<Page['getByRole']>[0], {
            name: target.name,
            exact: false,
          })
        : page.getByRole(target.value as Parameters<Page['getByRole']>[0]);
    case 'label':
      return page.getByLabel(target.value, { exact: false });
    case 'placeholder':
      return page.getByPlaceholder(target.value, { exact: false });
    case 'text':
      return page.getByText(target.value, { exact: false });
    case 'name':
      return page.locator(`[name="${cssQuote(target.value)}"]`);
    default:
      return page.locator(target.value);
  }
}

/** Escape a value going inside a CSS attribute selector's double quotes. */
function cssQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface Resolved {
  locator: Locator;
  rank: number;
  target: Target;
}

export interface ResolveFailure {
  candidates: { kind: Target['kind']; value: string; matches: number }[];
}

/**
 * Find the element, trying every stored candidate in order and taking the first
 * that resolves to exactly one visible node.
 *
 * THE FALLBACK IS THE FEATURE, not a safety net. When candidate 0 stops
 * matching and candidate 2 works, the site changed in a way this flow just
 * absorbed -- no model, no repair, no run failed, and the caller is told the
 * rank so the step can be rewritten with the survivor first. A step that
 * carried one selector would instead be an incident.
 *
 * Ambiguity counts as not found. Two matches means acting on a guess, and on a
 * page that files something with a government body a guess is the one outcome
 * worth failing to avoid.
 */
export async function resolveTarget(
  page: Page,
  targets: Target[],
  deadline: number,
): Promise<Resolved | ResolveFailure> {
  const counts = new Map<string, number>();
  let sweeps = 0;

  // Polled rather than awaited on one locator: `waitFor` would spend the whole
  // budget on candidate 0 and never reach the one that still works.
  for (;;) {
    for (let rank = 0; rank < targets.length; rank++) {
      const target = targets[rank];
      if (!target) continue;
      const found = await findAcrossFrames(page, target);
      counts.set(`${rank}`, found.matches);
      if (found.locator) return { locator: found.locator, rank, target };
    }
    if (Date.now() >= deadline) break;

    // STOP WAITING FOR A PAGE THAT IS ASKING WHETHER WE ARE A ROBOT.
    //
    // Waiting is right when the element is late; it is pure waste when the
    // portal has replaced the page with a verification screen, because nothing
    // we are looking for is ever going to appear. Measured on the real case:
    // twenty seconds of polling per step against google.com/sorry, and the
    // verdict at the end was the same one available in the first second.
    //
    // Checked every eighth sweep (~2s) rather than every sweep: it is a DOM
    // query in the hot loop of every step in the product, and a challenge that
    // is two seconds old is still a challenge.
    sweeps += 1;
    if (sweeps % 8 === 0 && (await looksLikeAChallenge(page))) break;

    await page.waitForTimeout(250).catch(() => undefined);
  }

  return {
    candidates: targets.map((t, i) => ({
      kind: t.kind,
      value: t.name ? `${t.value}[name=${t.name}]` : t.value,
      matches: counts.get(`${i}`) ?? 0,
    })),
  };
}

/**
 * EL DOCUMENTO PRIMERO, Y LUEGO DENTRO DE LOS MARCOS.
 *
 * ===========================================================================
 * POR QUÉ HACÍA FALTA
 * ===========================================================================
 * Todo este archivo buscaba con `page.getByRole(...)`, que mira EXCLUSIVAMENTE
 * el documento principal. Un portal que dibuja su formulario dentro de un
 * `<iframe>` era invisible: cero coincidencias en todos los candidatos, veinte
 * segundos de espera, y un veredicto de «el portal cambió» sobre un trámite
 * recién grabado que nunca llegó a tener ninguna posibilidad.
 *
 * Y eso no es un caso raro aquí. Media administración colombiana corre sobre
 * aplicaciones de hace quince años —Muisca por dentro, portales de aduana,
 * intranets de operadores— y ésas se construyeron con marcos. La grabación sí
 * los ve, porque una persona hace clic donde ve el botón; el que no los veía
 * era el que repite.
 *
 * ===========================================================================
 * EL ORDEN IMPORTA, Y LA AMBIGÜEDAD SIGUE MANDANDO
 * ===========================================================================
 * El documento principal va primero y gana si resuelve, porque es donde estaba
 * mirando este código hasta hoy y no hay motivo para cambiar un acierto.
 *
 * Sólo si el documento no da EXACTAMENTE UNA coincidencia se entra en los
 * marcos, y ahí se cuentan TODOS antes de decidir: dos marcos con un botón
 * «Continuar» cada uno son dos coincidencias, y dos coincidencias es
 * ambigüedad, que en este módulo significa no encontrado. Detenerse en el
 * primer marco que dé una sería exactamente el «actuar sobre una suposición»
 * que la regla de ambigüedad existe para prohibir — y en una página que radica
 * algo ante una entidad del Estado, esa suposición es la que no se puede hacer.
 *
 * El coste sólo lo paga quien lo necesita: una página sin marcos hace una
 * llamada de más a `page.frames()`, que es memoria del proceso, y ni una
 * consulta al DOM.
 */
async function findAcrossFrames(
  page: Page,
  target: Target,
): Promise<{ locator: Locator | null; matches: number }> {
  const count = async (where: Searchable): Promise<{ locator: Locator; matches: number }> => {
    const locator = buildLocator(where, target).locator('visible=true');
    try {
      return { locator, matches: await locator.count() };
    } catch {
      // Un marco puede desaparecer entre que se enumera y se consulta — es una
      // página viva. Eso es cero coincidencias, no un error del paso.
      return { locator, matches: 0 };
    }
  };

  const main = await count(page);
  if (main.matches === 1) return { locator: main.locator, matches: 1 };

  const frames = page.frames().slice(1);
  if (frames.length === 0) return { locator: null, matches: main.matches };

  let total = main.matches;
  let hit: Locator | null = null;
  for (const frame of frames) {
    const inFrame = await count(frame);
    total += inFrame.matches;
    if (inFrame.matches === 1 && !hit) hit = inFrame.locator;
  }

  // Uno en total y en un marco: es él. Más de uno, en cualquier combinación de
  // documento y marcos: ambiguo, y ambiguo es no encontrado.
  return total === 1 && hit ? { locator: hit, matches: 1 } : { locator: null, matches: total };
}

export function isResolved(value: Resolved | ResolveFailure): value is Resolved {
  return 'locator' in value;
}

/**
 * A cheap "is this a bot check" for the resolution loop.
 *
 * Deliberately weaker than the classifier: this only decides whether to STOP
 * WAITING, and being wrong costs a step that would have failed anyway a few
 * seconds earlier. The verdict — and therefore whether a model is allowed near
 * the flow — is still made in classify.ts from the full evidence bundle.
 */
export async function looksLikeAChallenge(page: Page): Promise<boolean> {
  try {
    if (/\/sorry\/|\/cdn-cgi\/challenge|__cf_chl|\/challenge-platform/.test(page.url())) {
      return true;
    }
    const frames = await page
      .locator(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
      )
      .count();
    return frames > 0;
  } catch {
    return false;
  }
}

/** How a target reads in the audit trail. Short, and never a value. */
export function describeTarget(target: Target): string {
  if (target.kind === 'role' && target.name) return `role=${target.value}[${target.name}]`;
  return `${target.kind}=${target.value}`;
}
