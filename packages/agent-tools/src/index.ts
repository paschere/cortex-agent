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
export * from './gsheets';
export * from './hubspot';
export * from './github';
export * from './linear';
export * from './kb';
export * from './schedule';
export * from './gdrive';
export * from './payroll';
export * from './web';
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

// Side-effect import: registers the sales.draft_proposal composite tool.
// Placed last so the registry + all primitive tools are initialized first.
export { salesDraftProposal } from './composite/sales-draft-proposal';

// The dev-task executor's pure core. Registers no tools — it is a library for
// the Inngest worker that turns a Linear issue into a pull request.
export * from './dev';
