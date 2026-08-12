import { generateText } from 'ai';
import { utilityModel } from '../model';
import { addSpend, spendOf } from './cost';
import type { ModelSpend, PageSnapshot, Step, Target } from './types';
import { EMPTY_SPEND } from './types';

/**
 * Finding an element that moved.
 *
 * This is the ONLY place a model is allowed to change a saved flow, it runs
 * only after `classify.ts` has returned `site-changed`, and what it is asked
 * for is deliberately tiny: not "fix this flow", not "drive this browser", but
 * "which of these elements is the one this step used to act on".
 *
 * WHY IT PICKS A REF INSTEAD OF WRITING A SELECTOR. The page snapshot already
 * carries, for every element, the ranked locators computed from the live DOM by
 * `services/browser/src/snapshot.ts`. If the model wrote selectors we would be
 * storing its guess about the markup; by having it name an element we store the
 * page's own description of that element. The model does the one thing it is
 * uniquely good at -- recognising that "Consultar placa" is the same button
 * that used to say "Consultar" -- and none of the things it is bad at.
 *
 * A repair never widens what the step does. The action, the value and the
 * variable binding are all left exactly as they were; only `targets` changes.
 */

export interface RepairRequest {
  step: Step;
  stepIndex: number;
  snapshot: PageSnapshot;
  /** Steps either side, so the model can see what the step is in the middle of. */
  context: { before: string[]; after: string[] };
}

export interface RepairOutcome {
  targets: Target[];
  /** One sentence for the version history. */
  note: string;
  spend: ModelSpend;
}

/** Injectable so the orchestrator can be tested without a provider key. */
export type Repairer = (request: RepairRequest) => Promise<RepairOutcome | null>;

function describeElement(el: PageSnapshot['elements'][number]): string {
  const bits = [`${el.ref}`, el.role];
  if (el.name) bits.push(`"${el.name}"`);
  bits.push(`<${el.tag}${el.type ? ` type=${el.type}` : ''}>`);
  if (el.disabled) bits.push('(deshabilitado)');
  return bits.join(' ');
}

function prompt(request: RepairRequest): string {
  const { step, snapshot, context } = request;
  const stored = step.targets
    .map((t, i) => `  ${i + 1}. ${t.kind}=${t.value}${t.name ? ` name="${t.name}"` : ''}`)
    .join('\n');

  return `Un trámite automatizado que antes funcionaba se rompió en un paso. El portal cambió y el elemento se movió o se renombró. Tu trabajo es identificar cuál de los elementos que hay HOY en la página es el mismo con el que trabajaba ese paso.

EL PASO QUE FALLÓ
  Acción: ${step.action}
  Se llama: "${step.label}"
${step.expect ? `  Después esperaba ver: "${step.expect}"\n` : ''}  Antes lo encontraba así (ninguna de estas formas funciona ya):
${stored || '  (sin localizadores guardados)'}

QUÉ PASA ANTES Y DESPUÉS EN EL TRÁMITE
  Antes: ${context.before.join(' → ') || '(es el primer paso)'}
  Después: ${context.after.join(' → ') || '(es el último paso)'}

LA PÁGINA AHORA
  Título: ${snapshot.title}
  Encabezados: ${snapshot.headings.join(' | ') || '(ninguno)'}
${snapshot.alerts.length > 0 ? `  Avisos en pantalla: ${snapshot.alerts.join(' | ')}\n` : ''}
ELEMENTOS DISPONIBLES
${snapshot.elements.map(describeElement).join('\n')}

REGLAS
- Responde SOLO con JSON: {"ref":"e12","confianza":"alta|media|baja","porque":"una frase"}
- Si ningún elemento cumple claramente la misma función, responde {"ref":null,"confianza":"baja","porque":"..."}. Decir que no lo encuentras es una respuesta correcta y útil; inventar uno rompe el trámite de forma silenciosa.
- No elijas un elemento sólo porque esté en una posición parecida. Tiene que hacer lo mismo.
- Si el paso escribe un dato (${step.action === 'fill' ? 'y este lo hace' : 'no es el caso aquí'}), el elemento tiene que ser un campo donde se pueda escribir ese dato, no un botón ni un enlace.
- Si lo que ves es una pantalla de inicio de sesión, un error del servidor o un mensaje de "no se encontró", responde ref:null: eso no es un cambio de diseño.`;
}

function parseJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const modelRepairer: Repairer = async (request) => {
  let spend = EMPTY_SPEND;
  if (request.snapshot.elements.length === 0) return null;

  const result = await generateText({
    model: utilityModel(),
    prompt: prompt(request),
    maxTokens: 400,
  });
  spend = addSpend(spend, spendOf(result.usage));

  const parsed = parseJson(result.text);
  const ref = parsed?.ref;
  if (typeof ref !== 'string' || ref.length === 0) return null;

  const element = request.snapshot.elements.find((el) => el.ref === ref);
  // A ref that is not on the page means the model made one up. Refusing is the
  // only safe response: there is nothing to fall back to that is not a guess.
  if (!element || element.targets.length === 0) return null;

  // Low confidence is treated as a refusal. A repair writes a new version of a
  // flow that somebody will later schedule to run unattended, and "probably
  // this one" is not the standard for that.
  if (String(parsed?.confianza ?? '').toLowerCase() === 'baja') return null;

  return {
    targets: element.targets,
    note: `El portal cambió; «${request.step.label}» ahora es ${element.role}${
      element.name ? ` «${element.name}»` : ''
    }. ${String(parsed?.porque ?? '').slice(0, 160)}`.trim(),
    spend,
  };
};
