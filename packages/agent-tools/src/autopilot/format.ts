import { money } from './collectors';
import { type AutopilotSettings, daysLabel, hourLabel } from './settings';
import {
  AREA_LABEL,
  AUTOPILOT_AREAS,
  type AutopilotPlan,
  type DecidedItem,
  LEVEL_LABEL,
} from './types';

/**
 * El plan y la configuración en texto, para el chat (`autopilot.plan`,
 * `autopilot.status`, `autopilot.configure`). Puro.
 */

function line(i: DecidedItem): string {
  const amount = i.amount ? ` · ${money(i.amount, i.currency ?? 'COP')}` : '';
  return `- **${i.title}**${amount} — ${i.why} _(${i.decisionReason})_`;
}

export function planMarkdown(
  plan: AutopilotPlan & { stillWaiting?: number },
  settings: AutopilotSettings,
  opts: { dryRun: boolean },
): string {
  const by = (d: DecidedItem['decision']) => plan.items.filter((i) => i.decision === d);
  const doing = by('do');
  const asking = by('ask');
  const telling = by('tell');
  const head = opts.dryRun
    ? `**Ensayo del piloto para hoy (${plan.day}) — no hice nada.**${settings.enabled ? '' : ' El piloto está apagado: esto es lo que haría si lo enciendes.'}`
    : `**Plan del piloto para hoy (${plan.day}).**`;
  const parts = [head];
  if (plan.items.length === 0)
    parts.push('No encontré nada que hacer, preguntar o contar hoy en los datos de la empresa.');
  if (doing.length)
    parts.push(
      `**${opts.dryRun ? 'Haría solo' : 'Hago solo'} (${doing.length})**\n${doing.map(line).join('\n')}`,
    );
  if (asking.length)
    parts.push(`**Necesita tu decisión (${asking.length})**\n${asking.map(line).join('\n')}`);
  if (telling.length)
    parts.push(`**Para que sepas (${telling.length})**\n${telling.map(line).join('\n')}`);
  if (plan.stillWaiting)
    parts.push(
      `Además, ${plan.stillWaiting} ${plan.stillWaiting === 1 ? 'cosa sigue' : 'cosas siguen'} esperando tu decisión desde otro día (en /piloto).`,
    );
  if (plan.sourceErrors.length)
    parts.push(
      `No pude mirar: ${plan.sourceErrors.map((e) => e.source).join(', ')}. Lo de ahí no está en el plan; no quiere decir que no haya nada.`,
    );
  parts.push(
    'Lo ves y lo cambias en /piloto. Lo que puedo hacer sin preguntar, en /admin/mandates.',
  );
  return parts.join('\n\n');
}

export function settingsMarkdown(s: AutopilotSettings): string {
  const levels = AUTOPILOT_AREAS.map((a) => `${AREA_LABEL[a]}: ${LEVEL_LABEL[s.areaLevels[a]]}`);
  return [
    s.enabled
      ? `El piloto está **encendido**: corre a las ${hourLabel(s.runHour)}, ${daysLabel(s.runDays)}${s.skipHolidays ? ', sin festivos' : ''}.`
      : 'El piloto está **apagado**.',
    `Niveles — ${levels.join(' · ')}.`,
    `Topes del día: ${s.maxActionsPerRun} acciones, ${s.maxExternalMessages} mensajes fuera de la empresa y ${money(s.maxAmountReferenced, s.currency)} en plata mencionada.`,
    s.quietDays.length ? `Días sin piloto: ${s.quietDays.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
