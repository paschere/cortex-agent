// La línea de mando: a quién le responde cada quien (migración 0106).
//
// El import con efecto secundario registra la herramienta en el catálogo, igual
// que el resto de los módulos.
import './tools';

export { directoryLine } from './tools';

export {
  MAX_LINE_DEPTH,
  buildOrgLine,
  chainAbove,
  escalationTarget,
  managerMapOf,
  personLabel,
  wouldCycle,
  type Chain,
  type DirectoryPerson,
  type DirectoryRole,
  type EscalationInput,
  type EscalationTarget,
  type EscalationVia,
  type LineNode,
  type ManagerLink,
  type ManagerMap,
  type OrgLine,
} from './line';

export {
  DIRECTORY_COLUMNS,
  adaptDirectoryPerson,
  emailsFor,
  listDirectory,
  loadManagerLinks,
  loadManagerMap,
  orgAdmins,
  setManager,
  type DirectoryRow,
  type SetManagerInput,
} from './store';
