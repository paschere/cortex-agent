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
export { writeAuditEvent } from './audit';
export { consumeToken } from './rate-limit';
export { createIntegrationsClient } from './integrations';
export * from './rate';
export * from './gmail';
export * from './gcal';
export * from './gsheets';
export * from './hubspot';
export * from './kb';
export * from './gdrive';
export * from './web';
export * from './format';
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

// Side-effect import: registers the sales.draft_proposal composite tool.
// Placed last so the registry + all primitive tools are initialized first.
export { salesDraftProposal } from './composite/sales-draft-proposal';
