/**
 * Aplicaciones (migración 0208): varias pantallas con menú, roles con scope
 * de filas y miembros de Cortex asignados a cada rol. Una pantalla es una
 * vista con `app_id`; los permisos se deciden en el servidor con
 * permissions.ts (puro) y store.ts (lecturas y escrituras con rol).
 */

import './tools';
import './design';
import './automations/tools';

export {
  appsAssignMembers,
  appsCreate,
  appsGet,
  appsInviteUsers,
  appsList,
  appsPublish,
  appsUpdate,
} from './tools';
export * from './permissions';
export * from './store';
export * from './templates';
export * from './install';
export * from './external';
export * from './automations';
export * from './kiosk';
export * from './portal';
export * from './appearance';
export * from './screen-extras';
export { appsDesign, reviewAppDraft, appDraftSchema } from './design';
export type { AppDraft, DraftReview, AutomationIdea } from './design';
