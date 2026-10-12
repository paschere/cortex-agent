import { type PlanState, planToolIds } from '@/lib/plan-state';
import { type Risk, riskOfTool } from '@/lib/risk';
import { toolDisplayName } from '@/lib/tool-labels';

/**
 * LA TARJETA «APROBAR EL PLAN», COMO DATOS.
 *
 * Pura y sin dependencias del servidor: la importan componentes del navegador.
 * Lo que la concesión REALMENTE cubre lo decide el servidor
 * (packages/agent-tools/src/security/plan-grant.ts, vía /api/chat/plan); aquí
 * sólo se acomoda lo que la persona va a leer: cada paso con sus herramientas
 * en español, el riesgo de cada una y cuáles seguirán preguntando.
 */

export interface PlanScope {
  /** Lo que la concesión cubrirá. */
  grantable: string[];
  /** Lo que el plan nombra y seguirá preguntando (envíos, pagos, borrados…). */
  alwaysAsk: string[];
}

export interface PlanToolView {
  id: string;
  label: string;
  risk: Risk;
  /** true cubierto · false seguirá preguntando · null aún no se sabe. */
  covered: boolean | null;
}

export interface PlanStepApproval {
  id: string;
  index: number;
  label: string;
  what?: string;
  tools: PlanToolView[];
  /** Alguna herramienta del paso seguirá mostrando su tarjeta. */
  asksAnyway: boolean;
}

export interface PlanApprovalModel {
  title: string;
  steps: PlanStepApproval[];
  coveredCount: number;
  askingCount: number;
}

/** ¿El plan nombra herramientas? Sin ellas no hay nada que aprobar de una vez. */
export function planNeedsApproval(plan: PlanState | null): plan is PlanState {
  return Boolean(plan && planToolIds(plan).length > 0);
}

export function planApprovalModel(plan: PlanState, scope: PlanScope | null): PlanApprovalModel {
  const covered = new Set(scope?.grantable ?? []);
  const asking = new Set(scope?.alwaysAsk ?? []);
  const steps = plan.steps.map((s, i): PlanStepApproval => {
    const tools = (s.tools ?? []).map(
      (id): PlanToolView => ({
        id,
        label: toolDisplayName(id),
        risk: riskOfTool(id),
        covered: !scope ? null : covered.has(id) ? true : asking.has(id) ? false : null,
      }),
    );
    return {
      id: s.id,
      index: i + 1,
      label: s.label,
      ...(s.what ? { what: s.what } : {}),
      tools,
      asksAnyway: tools.some((t) => t.covered === false),
    };
  });
  const all = steps.flatMap((s) => s.tools);
  return {
    title: plan.title,
    steps,
    coveredCount: new Set(all.filter((t) => t.covered === true).map((t) => t.id)).size,
    askingCount: new Set(all.filter((t) => t.covered === false).map((t) => t.id)).size,
  };
}

/** Lo que la persona «dice» al aprobar: entra como mensaje suyo (ver isControlHandoffMessage). */
export function planApprovalMessage(title: string, scope: PlanScope): string {
  const names = scope.grantable.map((id) => toolDisplayName(id)).join(', ');
  const ask = scope.alwaysAsk.length
    ? ` Lo que sale a terceros, mueve plata o borra (${scope.alwaysAsk
        .map((id) => toolDisplayName(id))
        .join(', ')}) me lo sigues preguntando.`
    : '';
  return `Aprobé el plan «${title}»: puedes usar sin volver a preguntarme ${names}, durante los próximos 30 minutos.${ask} Empieza por el primer paso y sigue hasta terminar.`;
}
