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
export * from './pipeline';
export * from './meetings';
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
