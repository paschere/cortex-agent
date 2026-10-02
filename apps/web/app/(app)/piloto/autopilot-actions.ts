import type { AutopilotActions } from '@/components/autopilot/types';
import { decideAutopilot, dryRunAutopilot, saveAutopilot } from './actions';

/** Las acciones de servidor del piloto, con la forma que piden los componentes. */
export const AUTOPILOT_ACTIONS: AutopilotActions = {
  save: saveAutopilot,
  dryRun: dryRunAutopilot,
  decide: decideAutopilot,
};
