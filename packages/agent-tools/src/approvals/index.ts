// La cola de llamadas paradas a la espera de un permiso — leída, nunca
// decidida. Ver `./tools.ts` para por qué no hay, ni va a haber, un
// `approvals.decide`.
//
// Registro por efecto de módulo, como todas las demás familias.
export { approvalsList } from './tools';

export {
  STAGED_VIA,
  STAGED_VIA_LABEL,
  approvalsListOutputSchema,
  pendingApprovalSchema,
  stagedViaOf,
} from './shape';
export type { ApprovalsListOutput, PendingApproval, StagedVia } from './shape';

// La frase que describe una llamada parada sin enseñar su payload. Exportada
// porque la copia del navegador (`apps/web/lib/tool-labels.ts`) se compara
// contra ésta en una prueba, que es lo único que mantiene honesta la
// duplicación.
export { TOOL_LABEL_TEXT, describePendingCall, pendingSummary, pendingToolLabel } from './summary';
