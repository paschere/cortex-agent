import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type TemplateContext, renderTemplate } from '../automations/engine';
import type { AutomationAction } from '../automations/spec';
import type { CustomAppRow } from '../store';
import { buildRuleInput } from './functions';
import { runAppFunction, systemAppAccess } from './run-function';

/**
 * LA ACCIÓN `run_function` DE UNA REGLA (fase 2).
 *
 * La función corre con el rol que la acción nombra, a nombre de quien creó la
 * regla (para que lo que escriba tenga un autor real). Un error de la función
 * hace fallar la acción: queda en el historial de la regla con el mensaje. El
 * resultado de la función se resume en una línea para ese historial.
 */

export type RunFunctionAction = Extract<AutomationAction, { type: 'run_function' }>;

export async function runFunctionAction(args: {
  db: SupabaseClient;
  organizationId: string;
  app: CustomAppRow;
  automation: { id: string; name: string; created_by: string | null; trigger: { type: string } };
  action: RunFunctionAction;
  ctx: TemplateContext;
  rowId?: string | null;
}): Promise<string> {
  const { db, app, automation, action, ctx } = args;
  const memberId = automation.created_by ?? app.created_by;
  if (!memberId)
    throw new ValidationError(
      'La regla no tiene autor: no se sabe a nombre de quién correr la función.',
    );
  const hasRow = Boolean(args.rowId);
  const input = buildRuleInput(
    action.input,
    (text) => renderTemplate(text, ctx),
    action.withRow && hasRow ? { id: args.rowId ?? undefined, values: ctx.after } : null,
  );
  const label = `Regla «${automation.name}»`;
  const access = await systemAppAccess(db, app, action.role, memberId, label);
  const out = await runAppFunction(db, access, action.name, input, {
    trigger: automation.trigger.type === 'schedule' ? 'schedule' : 'rule',
    organizationId: args.organizationId,
    actorLabel: label,
  });
  if (!out.ok) throw new Error(`La función «${action.name}» falló: ${out.error ?? 'sin detalle'}`);
  const summary = summarizeResult(out.result);
  return `Corrió la función «${action.name}» con el rol «${action.role}» (${out.durationMs} ms)${summary ? `: ${summary}` : '.'}`;
}

/** El resultado de la función en una línea corta para el historial. */
export function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}
