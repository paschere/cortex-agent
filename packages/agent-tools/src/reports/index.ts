/**
 * Informes — a report Cortex builds, that is read on screen, saved as a
 * snapshot, and can be shared.
 *
 * Not the same thing as `presentations/`, and deliberately not built on it: a
 * PDF is a document you mail to a client and archive. This is a document you
 * READ, reopen in November and cite a figure out of. Different artifact,
 * different storage, different sharing posture — see the header of `store.ts`
 * for the three-way split between the link, the export and the PDF.
 *
 * The four decisions, each argued where it lives:
 *
 *   document.ts  why the model produces a DATA STRUCTURE and never markup
 *   render.ts    why there is exactly one renderer, and why it emits a string
 *   charts.ts    why the charts are server-side SVG with no client JavaScript
 *   store.ts     why saving means photographing, and how the freeze is checked
 */

// Side-effect import: registers reports.generate / list / open / share.
import './tools';
// …and reports.chart, which draws inside a conversation. Separate module
// because it is the one report that is not computed from a kind and some
// parameters — see the header of `chat-chart.ts`.
import './chat-chart';
// …y reports.compose / run / recipes: el informe de lo que sea, armado con
// bloques. Ver la cabecera de `recipe.ts` para por qué el asunto del informe
// dejó de vivir en `reports.kind`.
import './custom';

export { reportsGenerate, reportsList, reportsOpen, reportsShare } from './tools';

export { reportsCompose, reportsRun, reportsRecipes, runRecipeAndSave } from './custom';

export {
  BLOCKS,
  BLOCK_IDS,
  blockIsRestricted,
  getBlock,
  isBlockId,
  runBlock,
} from './blocks';
export type { BlockBuildInput, BlockOutput, ReportBlock } from './blocks';

export {
  MAX_BLOCKS,
  RECIPE_COLUMNS,
  REPORT_RECIPES_TABLE,
  UnknownBlockError,
  blockCatalog,
  findRecipeByFingerprint,
  getRecipe,
  listRecipes,
  recipeFingerprint,
  recipeIsRestricted,
  recipeSpecSchema,
  runRecipe,
  saveRecipe,
  touchRecipe,
} from './recipe';
export type {
  BlockId,
  RecipeBlock,
  RecipeRow,
  RecipeSpec,
  RunRecipeInput,
  SaveRecipeInput,
  SaveRecipeResult,
} from './recipe';

export {
  CHAT_CHARTS_TABLE,
  CHAT_CHART_COLUMNS,
  CHAT_CHART_KEEP_DAYS,
  chartReportUrl,
  chatChartDocument,
  getChatChart,
  insertChatChart,
  purgeChatCharts,
  renderChatChartHtml,
  reportsChart,
  saveChartAsReport,
} from './chat-chart';
export type { ChatChartInput, ChatChartRow } from './chat-chart';

// The four chart shapes as markup. Exported so a surface that renders one
// section on its own does not have to reach into the module.
export { renderChart } from './charts';
export type { ChartRenderOptions } from './charts';

export {
  GENERATED_REPORT_KINDS,
  REPORT_DOCUMENT_VERSION,
  REPORT_KINDS,
  REPORT_KIND_BLURB,
  REPORT_KIND_LABEL,
  UnsourcedFigureError,
  figuresOf,
  reportDocumentSchema,
  sourceById,
  sourceIndex,
  validateDocument,
} from './document';
export type {
  ChartBody,
  Figure,
  GeneratedReportKind,
  Metric,
  ReportDocument,
  ReportKind,
  ReportSection,
  ReportSource,
  ReportTable,
  Tone as ReportTone,
} from './document';

export { buildReport, buildWeekly, mondayOf, weekSpan } from './build';
export type {
  BuildInput as ReportBuildInput,
  GroupByPerson,
  ReportParams,
  WeeklyInput,
  WeeklyPeople,
  WeeklyPerson,
} from './build';

export {
  REPORT_CSS,
  RENDERER_VERSION,
  describeDocument,
  renderReportHtml,
  renderStandaloneHtml,
} from './render';

export {
  DEFAULT_SHARE_DAYS,
  REPORTS_TABLE,
  REPORT_COLUMNS,
  REPORT_SUMMARY_COLUMNS,
  RestrictedReportError,
  appBaseUrl as reportsAppBaseUrl,
  canonicalize,
  claimWeeklyReport,
  documentHash,
  exportUrl,
  getReport,
  hydrateRow,
  listReports,
  mintShareToken,
  reportUrl,
  revokeShare,
  safeFilename as safeReportFilename,
  saveReport,
  shareExpiresIn,
  shareIsLive,
  shareReport,
  shareUrl,
} from './store';
export type {
  ClaimWeeklyInput,
  ClaimWeeklyResult,
  ReportRow,
  StoredReport,
  ShareResult,
} from './store';
