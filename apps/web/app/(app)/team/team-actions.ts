import type { TeamActions } from '@/components/team/types';
import {
  configureWork,
  markWorkDone,
  reassignWork,
  saveAwayDays,
  suggestWorkMapping,
} from './actions';

/** Las acciones de servidor de «Equipo», con la forma que piden los componentes. */
export const TEAM_ACTIONS: TeamActions = {
  reassign: reassignWork,
  markDone: markWorkDone,
  saveAway: saveAwayDays,
  suggestMapping: suggestWorkMapping,
  configure: configureWork,
};
