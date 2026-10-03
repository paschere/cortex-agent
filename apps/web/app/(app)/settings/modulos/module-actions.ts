import type { ModuleActions } from '@/components/modules/types';
import { applyPreset, previewPreset, toggleModule } from './actions';

/** Las acciones de servidor de los módulos, con la forma que piden los componentes. */
export const MODULE_ACTIONS: ModuleActions = {
  toggle: toggleModule,
  previewPreset,
  applyPreset,
};
