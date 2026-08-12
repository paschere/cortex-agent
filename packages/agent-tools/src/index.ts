// Registry primitives (registerTool/getTool/listTools/filterTools/runTool) live in
// the leaf module './registry' and are re-exported here FIRST. This ordering is
// load-bearing: every tool file imports `registerTool` from '../index', and the
// tool barrels below (`export * from './hubspot'` etc.) register at module load.
// Re-exporting the registry before the barrels guarantees registry.ts is fully
// initialized (its REGISTRY Map constructed) before any registerTool() call runs.
// Inlining the registry here instead caused a TDZ crash at runtime:
// "Cannot access 'REGISTRY' before initialization" — because the hoisted barrel
// re-exports evaluated above the inlined `const REGISTRY`.
export * from './registry';
export * from './types';
// The workspace boundary. Exported early and from a leaf module (it imports
// nothing from this package) so anything below can reach it without a cycle.
export * from './tenancy';
export * from './model';
export { writeAuditEvent } from './audit';
export { consumeToken } from './rate-limit';
export { createIntegrationsClient } from './integrations';
export * from './gmail';
export * from './gcal';
// Microsoft 365 through Graph: the same mail and calendar surface as the two
// above, for the customers who run Outlook instead. `./msgraph` is the shared
// client and registers nothing.
export * from './msgraph';
export * from './outlook';
export * from './mscal';
export * from './gsheets';
export * from './hubspot';
export * from './github';
export * from './linear';
// What using Cortex taught it (migration 0083). Placed before ./kb because
// retrieval reads its adjustments, and its own leaf modules import nothing from
// this package.
export * from './learning';
export * from './kb';
export * from './schedule';
export * from './gdrive';
export * from './payroll';
export * from './web';
// Next to ./web because it is the same axis -- the open internet -- one step
// further along: ./web reads pages, ./browser fills in their forms. See
// packages/agent-tools/src/browser/index.ts.
export * from './browser';
export * from './format';
export * from './presentations';
export * from './slack';
export * from './people';
export * from './growth';
export * from './vehicles';
// Dated promises Cortex watches on its own — fleet paperwork, contracts,
// customs deadlines, payments. Placed after ./vehicles because the fleet sync
// reads what the RUNT consults left behind, and after ./kb because the
// extraction path goes through the spaces boundary.
export * from './commitments';
// The customer companies everything else hangs off (migration 0075). Placed
// after ./commitments because the client card reads commitment rows and adopts
// the ones whose counterparty already named the client by hand.
export * from './clients';
// Facturas, guías, declaraciones and the rest, read into fields that can be
// summed (migration 0076). Placed after ./clients because a confirmed NIT is
// matched against the client list, and after ./kb because the text it reads and
// the visibility rule it obeys both live there.
export * from './documents';
// The tissue between an answer and something done about it: a drafted action
// waiting on a human. Placed after ./commitments and ./gmail because it reads
// commitment rows to draft from them and binds gmail.send_message to run.
export * from './actions';
// Informes: text and charts, read on screen, saved as a snapshot, shareable
// (migration 0079). Placed after ./commitments and ./vehicles because it reads
// both to build its reports; it registers no source of truth of its own.
export * from './reports';
// Encargos (migration 0089): a job handed over and worked unattended for
// minutes or hours. The EXECUTION engine lives in apps/web/lib/errands, which
// needs Inngest and the orchestrator; what is here is the vocabulary every
// surface shares, the spend ceilings, and the three tools the chat calls by
// name. It reaches ./billing (the plan meter gates commissioning) and ./web
// (its legs search the internet) through direct module imports rather than
// this barrel, so the position of this line does not decide anything.
export * from './errands';
export * from './pipeline';
export * from './meetings';
// Library only — no tools are registered here. WhatsApp is a surface Cortex
// listens on, not a system it calls. See ./whatsapp/index.ts.
export * from './whatsapp';
export * from './cortex';
export * from './memory';
export * from './security';
export * from './chat';
export * from './inbox';
export {
  isPrivateUrl,
  fetchExternalToolManifest,
  callExternalTool,
  fetchEnabledExternalTools,
  syncExternalServerManifest,
} from './external-mcp';
export type {
  ExternalToolManifestEntry,
  ExternalServerRow,
  EnabledExternalServer,
} from './external-mcp';

// Tools a customer defined for themselves, from the app, with no code. Rows of
// `custom_tools` (migration 0067) become ordinary ToolDefs under `custom.<slug>`
// and run through runTool like everything else. Placed after the barrels for
// symmetry with them; it registers nothing, since these tools are per-workspace
// and are built per request rather than at module load.
export * from './custom-tools';

// Semantic tool selection: which of the tools a user may call are worth
// sending the model this turn. Placed after the tool barrels so the registry is
// fully populated, though it takes its candidates as an argument and never
// reads the registry itself — Google Chat and the web chat pass different sets.
export * from './tool-selection';

// What a turn actually handed the model, captured as it happened (migration
// 0080). Placed after ./tool-selection and ./kb because it records what those
// two produced; it calls neither, and holds no tools of its own.
export * from './turn-context';

// How long a turn took and where the time went (migration 0084). Beside the
// capture above rather than inside it: same turn, but a numeric series read in
// aggregate, not a forensic record read one row at a time.
export * from './latency';

// Whether a change made the answers better or worse, with a number (migration
// 0082). Placed last of the library modules because it reads almost all of
// them — the chunker, the embedder, the relevance cuts, the tool ranker, the
// registry — and is read by none of them. Registers no tools: an evaluation the
// agent could run on itself would be one more thing to grade.
export * from './evaluation';

// Side-effect import: registers the sales.draft_proposal composite tool.
// Placed last so the registry + all primitive tools are initialized first.
export { salesDraftProposal } from './composite/sales-draft-proposal';

// The dev-task executor's pure core. Registers no tools — it is a library for
// the Inngest worker that turns a Linear issue into a pull request.
export * from './dev';

// Two modules independently coined `ClaimResult`: an errand being claimed by a
// person, and a dev task being claimed by a worker. Both are legitimate names
// in their own file and neither knows about the other, which is what a flat
// barrel turns into an error (TS2308). The errand one wins the bare name
// because it is the product concept; the executor's is reached from
// `agent-tools/src/dev/claim` by the one worker that needs it, and nothing
// imports either through the barrel today.
export type { ClaimResult } from './errands';

// Plans, consumption and the first ten minutes of a new company (migration
// 0085). Registers no tools: it is what decides whether the rest of them may
// run, and what a workspace is shown about what it has used.
export * from './billing';
