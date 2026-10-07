/**
 * Aplicaciones (migración 0208): varias pantallas con menú, roles con scope
 * de filas y miembros de Cortex asignados a cada rol. Una pantalla es una
 * vista con `app_id`; los permisos se deciden en el servidor con
 * permissions.ts (puro) y store.ts (lecturas y escrituras con rol).
 */

import './tools';

export { appsCreate, appsList } from './tools';
export * from './permissions';
export * from './store';
export * from './templates';
export * from './install';
