/**
 * Módulos por empresa (migración 0186): cada área grande de Cortex se prende
 * o se apaga por empresa.
 *
 *   catalog.ts  el contrato: claves, rótulos, prefijos de herramientas, rutas
 *   store.ts    qué tiene prendido cada empresa, la regla de dependencias y
 *               la escritura (sólo administradores o el dueño)
 *   presets.ts  «¿qué hace tu empresa?»: un punto de partida por tipo
 *   tools.ts    modules.list / modules.set
 */

// Registro de las herramientas (por importarlas).
export { modulesList, modulesSet } from './tools';

export {
  type CortexModule,
  MODULES,
  MODULE_KEYS,
  type ModuleKey,
  moduleByKey,
  moduleForRoute,
  moduleForTool,
} from './catalog';
export { MODULE_PRESETS, type ModulePreset, presetByKey } from './presets';
export {
  type ModuleChange,
  ModuleDisabledError,
  type ModulePlan,
  type ModuleState,
  type SetModulesResult,
  defaultModules,
  disabledModuleForTool,
  enabledModules,
  forgetModules,
  isModuleEnabled,
  isModuleKey,
  moduleOffMessage,
  planModuleChanges,
  previewModuleChanges,
  readModuleStates,
  requiredBy,
  requiredClosure,
  resolveModules,
  setModule,
  setModules,
  toolAllowedByModules,
  withoutDisabledModules,
} from './store';
