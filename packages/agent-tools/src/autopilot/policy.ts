import {
  type MandateGrant,
  type MandateTool,
  applyMandate,
  isDelegatable,
  mandateMiss,
} from '../security/mandate';
import { mandatoryHumanConfirmation } from '../security/mandatory-confirmation';
import { DEFAULT_POLICY, type SecurityPolicy, classify, decide } from '../security/policy';
import type { AutopilotSettings } from './settings';
import type {
  AutopilotAuthority,
  AutopilotDecision,
  AutopilotEffect,
  DecidedItem,
  PlanItem,
} from './types';

/**
 * LA POLÍTICA: POR CADA COSA DEL DÍA, ¿LA HAGO, LA PREGUNTO O SÓLO LA CUENTO?
 *
 * Función pura. Recibe las cosas que encontraron los recolectores, la
 * configuración de la empresa, los mandatos vigentes y una forma de mirar la
 * herramienta; devuelve cada cosa con su decisión y la razón en español.
 *
 * ===========================================================================
 * LAS REGLAS, EN ORDEN (la primera que aplica, decide)
 * ===========================================================================
 *   1. Sin acción propuesta, o el área en «avisar»            → contar.
 *   2. La herramienta no existe                                → contar.
 *   3. Mueve plata (efecto `money`, o la herramienta es de las
 *      que siempre piden a una persona)                        → preguntar. Nunca hacer.
 *   4. El área en «proponer»                                   → preguntar.
 *   5. Riesgo alto                                             → preguntar.
 *   6. Sale de la empresa: sólo con un mandato que cubra ESTA
 *      llamada desatendida, y si la capa de seguridad la
 *      dejaría pasar sin nadie mirando; además dentro del tope
 *      de mensajes del día                                    → hacer; si no, preguntar.
 *   7. Interna: hace si es de las rutinarias (categorizar, atar
 *      un pago sin duda, reintentar una sincronización, avisarle
 *      a alguien del equipo) con riesgo bajo, o si un mandato
 *      la cubre                                               → hacer; si no, preguntar.
 *   8. Topes del día: acciones por corrida y plata mencionada
 *      — lo que no cabe                                       → preguntar.
 *
 * ===========================================================================
 * POR QUÉ LA POLÍTICA CONSULTA A LA CAPA DE SEGURIDAD
 * ===========================================================================
 * El piloto ejecuta por `runTool` con `surface: 'schedule'`, la misma puerta
 * que cualquier rutina. Esa puerta convierte en CRÍTICO (y bloquea) un envío
 * que clasifica como externo y desatendido, con o sin mandato; y una
 * herramienta que pide confirmación sólo pasa sin persona si un mandato
 * desatendido la cubre. Si la política dijera «hacer» a algo que la puerta va
 * a parar, la ejecución se estrellaría todas las mañanas. Así que la política
 * le pregunta a la misma doctrina (`classify` + `decide` + `applyMandate`) qué
 * pasaría, y sólo dice «hacer» a lo que de verdad va a pasar. El día que la
 * doctrina cambie, la política la sigue sin tocarla.
 *
 * Para un mensaje externo eso significa: SÓLO con un mandato que diga
 * «también sin nadie mirando» (`applies_unattended`), dentro de sus límites, y
 * dentro del tope de mensajes del día que fijó la empresa.
 */

/** Lo que la política necesita saber de una herramienta. */
export interface ToolFacts extends MandateTool {
  requiresConfirmation?: boolean;
}

/**
 * Las herramientas rutinarias: internas, reversibles o inocuas, y que el
 * piloto puede hacer solo cuando el área está en «hacer» sin que haga falta un
 * mandato. Lista cerrada a propósito: una herramienta nueva no entra aquí por
 * parecerse a otra.
 */
export const ROUTINE_TOOL_IDS: ReadonlySet<string> = new Set([
  // Categorizar lo que no tiene categoría (nunca toca una que ya tenga).
  'ledger.categorize_pending',
  // Atar un pago del banco a su factura cuando casa sin duda.
  'payments.apply_to_invoice',
  // Reintentar sincronizaciones caídas.
  'trackers.retry_sync',
  'accounting.sync_now',
  // Recordarle a alguien del equipo (campana interna, nunca fuera de la empresa).
  'autopilot.remind',
]);

export interface PolicyContext {
  settings: AutopilotSettings;
  mandates: MandateGrant[];
  tool: (id: string) => ToolFacts | undefined;
  /** La doctrina de la empresa. Por defecto, la de la casa. */
  securityPolicy?: SecurityPolicy;
  /** Lo ya gastado hoy por corridas anteriores (normalmente cero). */
  spentToday?: { actions: number; externalMessages: number; amount: number };
  now?: Date;
}

interface Budget {
  actions: number;
  externalMessages: number;
  amount: number;
}

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

/** El efecto real: el más estricto entre lo que dice el recolector y lo que dice el id. */
export function effectiveEffect(item: PlanItem): AutopilotEffect | null {
  const action = item.proposedAction;
  if (!action) return null;
  if (item.effect === 'money' || mandatoryHumanConfirmation(action.toolId)) return 'money';
  if (/^(payments|banking|payroll)\.(pay|transfer|send|execute|approve)/.test(action.toolId))
    return 'money';
  return item.effect ?? 'internal_write';
}

function money(n: number, currency: string): string {
  if (currency === 'COP')
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(n);
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(n)} ${currency}`;
}

interface Verdict {
  decision: AutopilotDecision;
  reason: string;
  authority: AutopilotAuthority | null;
  mandate: MandateGrant | null;
}

const tell = (reason: string): Verdict => ({
  decision: 'tell',
  reason,
  authority: null,
  mandate: null,
});
const ask = (reason: string): Verdict => ({
  decision: 'ask',
  reason,
  authority: null,
  mandate: null,
});

/**
 * ¿Qué diría la puerta de `runTool` a esta llamada desatendida? Devuelve el
 * mandato que la levantaría (si hace falta y hay), o por qué no pasaría.
 */
export function previewGate(
  tool: ToolFacts,
  input: unknown,
  ctx: Pick<PolicyContext, 'mandates' | 'securityPolicy' | 'now'>,
  opts: { routineConfirmed: boolean },
): { pass: true; mandate: MandateGrant | null } | { pass: false; why: 'blocked' | 'needs_person' } {
  const classification = classify({
    tool,
    input,
    ctx: { now: ctx.now, confirmed: opts.routineConfirmed },
    surface: 'schedule',
  });
  const doctrine = decide(classification, ctx.securityPolicy ?? DEFAULT_POLICY);
  if (doctrine === 'block') return { pass: false, why: 'blocked' };
  const outcome = applyMandate({
    classification,
    decision: doctrine,
    tool,
    input,
    surface: 'schedule',
    mandates: ctx.mandates,
  });
  if (outcome.decision === 'block') return { pass: false, why: 'blocked' };
  if (mandatoryHumanConfirmation(tool.id)) return { pass: false, why: 'needs_person' };
  if (outcome.mandate) return { pass: true, mandate: outcome.mandate };
  const gated = outcome.decision === 'confirm' || tool.requiresConfirmation === true;
  // Una rutina que el dueño encendió pasa como confirmada (igual que una
  // rutina con escrituras desatendidas, schedule-run.ts); cualquier otra
  // llamada con puerta necesita un mandato.
  if (gated && !opts.routineConfirmed) return { pass: false, why: 'needs_person' };
  return { pass: true, mandate: null };
}

/** El mandato que cubriría la llamada si no fuera por la superficie (para explicar). */
function attendedMandate(
  tool: ToolFacts,
  input: unknown,
  mandates: MandateGrant[],
  now?: Date,
): MandateGrant | null {
  const classification = classify({ tool, input, ctx: { now }, surface: 'web' });
  if (!isDelegatable(classification, tool.id)) return null;
  return (
    mandates.find(
      (m) => mandateMiss(m, { classification, tool, input, surface: 'web' }) === null,
    ) ?? null
  );
}

function decideOne(item: PlanItem, ctx: PolicyContext, budget: Budget): Verdict {
  const { settings } = ctx;
  const level = settings.areaLevels[item.area];
  const action = item.proposedAction;
  if (!action) return tell('Es para que lo sepas: no hay nada que yo pueda hacer al respecto.');
  if (level === 'avisar')
    return tell('Esta área está en «sólo avisar»: te lo cuento y no preparo nada.');

  const tool = ctx.tool(action.toolId);
  if (!tool) return tell('No tengo cómo hacer esto desde aquí; te lo cuento para que lo veas.');

  const effect = effectiveEffect(item);
  if (effect === 'money')
    return ask('Mueve plata: eso nunca lo hago solo. Te lo dejo listo para que tú decidas.');

  if (level === 'proponer')
    return ask('Esta área está en «proponer»: te lo dejo listo para que lo apruebes.');

  if (RISK_RANK[item.risk] >= RISK_RANK.high)
    return ask('Es de riesgo alto: prefiero que lo mires antes.');

  // --- Topes del día --------------------------------------------------------
  if (budget.actions >= settings.maxActionsPerRun)
    return ask(
      `Ya hice ${settings.maxActionsPerRun} cosas hoy, que es el tope que fijaste; esta queda para que la apruebes.`,
    );
  const amount = item.amount ?? 0;
  const sameCurrency = !item.currency || item.currency.toUpperCase() === settings.currency;
  if (amount > 0 && !sameCurrency)
    return ask(
      `Menciona ${money(amount, item.currency?.toUpperCase() ?? '')} y tu tope está en ${settings.currency}: no comparo monedas distintas, así que te pregunto.`,
    );
  if (amount > 0 && budget.amount + amount > settings.maxAmountReferenced)
    return ask(
      `Con esta pasaría el tope de ${money(settings.maxAmountReferenced, settings.currency)} en plata mencionada por día que fijaste.`,
    );

  if (effect === 'external_message') {
    if (budget.externalMessages >= settings.maxExternalMessages)
      return ask(
        settings.maxExternalMessages === 0
          ? 'Tu configuración no deja salir mensajes de la empresa sin tu visto bueno.'
          : `Ya salieron ${settings.maxExternalMessages} mensajes hoy, que es tu tope.`,
      );
    const gate = previewGate(tool, action.input, ctx, { routineConfirmed: false });
    if (gate.pass && gate.mandate)
      return {
        decision: 'do',
        reason: `Lo cubre el mandato «${gate.mandate.label}».`,
        authority: 'mandate',
        mandate: gate.mandate,
      };
    if (!gate.pass && gate.why === 'blocked')
      return ask(
        'La capa de seguridad no deja salir este mensaje sin nadie mirando. Está listo: apruébalo con un clic.',
      );
    const attended = attendedMandate(tool, action.input, ctx.mandates, ctx.now);
    if (attended)
      return ask(
        `El mandato «${attended.label}» me deja enviarlo cuando estás en la conversación, pero no en la rutina de la mañana (no dice «también sin nadie mirando»). Está listo: apruébalo con un clic.`,
      );
    return ask(
      'Sale de la empresa y no hay un mandato que me deje enviarlo sin preguntarte. Está listo: apruébalo con un clic.',
    );
  }

  // --- Interno ---------------------------------------------------------------
  const routine = ROUTINE_TOOL_IDS.has(tool.id);
  if (routine && item.risk === 'low') {
    const gate = previewGate(tool, action.input, ctx, { routineConfirmed: true });
    if (gate.pass)
      return {
        decision: 'do',
        reason: gate.mandate
          ? `Lo cubre el mandato «${gate.mandate.label}».`
          : 'Es interno, rutinario y de riesgo bajo, y el área está en «hacer».',
        authority: gate.mandate ? 'mandate' : 'routine',
        mandate: gate.mandate,
      };
    return ask(
      gate.why === 'blocked'
        ? 'La capa de seguridad no deja hacer esto sin nadie mirando.'
        : 'Esto pide a una persona; te lo dejo listo.',
    );
  }
  const gate = previewGate(tool, action.input, ctx, { routineConfirmed: false });
  if (gate.pass && gate.mandate)
    return {
      decision: 'do',
      reason: `Lo cubre el mandato «${gate.mandate.label}».`,
      authority: 'mandate',
      mandate: gate.mandate,
    };
  return ask(
    routine
      ? 'Es de riesgo medio: prefiero que lo apruebes.'
      : 'No es de lo rutinario que hago solo y no hay un mandato que lo cubra.',
  );
}

/**
 * Decide todas las cosas del día. El orden importa por los topes: van primero
 * las de menor riesgo y, entre iguales, las de más plata (lo que más pesa se
 * resuelve primero si cabe).
 */
export function decidePlan(items: PlanItem[], ctx: PolicyContext): DecidedItem[] {
  const budget: Budget = {
    actions: ctx.spentToday?.actions ?? 0,
    externalMessages: ctx.spentToday?.externalMessages ?? 0,
    amount: ctx.spentToday?.amount ?? 0,
  };
  const ordered = [...items].sort(
    (a, b) =>
      RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
      (b.amount ?? 0) - (a.amount ?? 0) ||
      a.dedupeKey.localeCompare(b.dedupeKey),
  );
  const out: DecidedItem[] = [];
  for (const item of ordered) {
    const v = decideOne(item, ctx, budget);
    if (v.decision === 'do') {
      budget.actions += 1;
      budget.amount += item.amount ?? 0;
      if (effectiveEffect(item) === 'external_message') budget.externalMessages += 1;
    }
    out.push({
      ...item,
      decision: v.decision,
      decisionReason: v.reason,
      authority: v.authority,
      mandateId: v.mandate?.id ?? null,
      mandateLabel: v.mandate?.label ?? null,
    });
  }
  return out;
}
