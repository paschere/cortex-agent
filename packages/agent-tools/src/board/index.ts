/**
 * Informe para socios (migración 0191): el informe mensual de gerencia armado
 * con los datos (estados, presupuesto, caja, cartera, Gerencia, vencimientos),
 * su resumen verificado, el PDF con la marca, el enlace con contraseña y
 * `board.generate` / `board.send`. Los clientes del navegador sólo importan
 * TIPOS de aquí.
 */
export { boardEmail, boardGenerate, boardSend } from './tools';
export {
  BOARD_SECTIONS,
  BOARD_SECTION_TITLE,
  DEFAULT_BOARD_SETTINGS,
  PERIOD_RE as BOARD_PERIOD_RE,
  boardMarkdown,
  defaultPeriod as defaultBoardPeriod,
  periodLabel as boardPeriodLabel,
} from './shape';
export type {
  BoardContent,
  BoardFact,
  BoardReport,
  BoardSection,
  BoardSectionKey,
  BoardSettings,
  BoardStatus,
  BoardTable,
  BoardVisibility,
} from './shape';
export { composeBoard } from './compose';
export type { BoardInput, Composed as ComposedBoard } from './compose';
export { modelBoardWriter, writeBoardSummary } from './writer';
export type { BoardWriter } from './writer';
export { renderBoardPdf } from './pdf';
export type { BoardPdfBrand } from './pdf';
export { gatherBoardInput, generateBoardReport } from './generate';
export {
  BOARD_TOOL_ID,
  boardPasswordHash,
  boardPublicUrl,
  cleanRecipients as cleanBoardRecipients,
  countBoardOpen,
  ensureBoardLink,
  findBoardByToken,
  getBoardReport,
  getBoardReportByPeriod,
  listBoardReports,
  markBoardSent,
  readBoardSettings,
  requireBoardManager,
  saveBoardReport,
  saveBoardSettings,
  setBoardAccess,
  unlockBoardReport,
} from './store';
export type { BoardUnlockOutcome, PublicBoardRow } from './store';
