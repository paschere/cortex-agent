/**
 * Custom tools: an organization's own HTTP integrations, defined from the app.
 *
 * Read `tool-def.ts` first — it is the seam where a row of `custom_tools`
 * becomes an ordinary `ToolDef` and everything downstream stops needing to know
 * the difference. `guard.ts` is the file to read second, and the one to be
 * careful with: it decides where our server is willing to send a request.
 */

export {
  type CustomToolAuthType,
  type CustomToolBodyEncoding,
  type CustomToolField,
  type CustomToolFieldType,
  type CustomToolInputSchema,
  type CustomToolMethod,
  type CustomToolResult,
  type CustomToolRow,
  type CustomToolSummary,
  CUSTOM_TOOL_FAMILY,
  CUSTOM_TOOL_PREFIX,
  EXECUTION_COLUMNS,
  MAX_TOOLS_PER_ORG,
  SAFE_COLUMNS,
  WRITE_METHODS,
  customToolId,
  isWriteMethod,
} from './types';

export {
  type ApprovedDestination,
  type HostResolver,
  type ResolvedAddress,
  BlockedDestinationError,
  assertPublicUrl,
  describeStaticUrlProblem,
  isBlockedAddress,
  isReservedHostname,
  nodeResolver,
} from './guard';

export {
  type RenderedBody,
  isReservedHeader,
  isValidHeaderName,
  placeholdersIn,
  renderBody,
  renderHeaders,
  renderUrl,
  sanitizeHeaderValue,
} from './template';

export { FIELD_NAME_RE, buildInputSchema } from './schema';

export { type SelectedResponse, parsePath, selectResponse } from './response';

export { type RawRequest, type RawResponse, type HttpOutcome, sendRequest } from './http';

export {
  type BuiltRequest,
  type ExecuteDetail,
  type ExecuteOptions,
  REDACTED,
  buildRequest,
  executeCustomTool,
  redact,
} from './execute';

export { type CustomToolDefOptions, customToolDef } from './tool-def';

export { CUSTOM_TOOLS_TABLE, fetchCustomToolById, fetchEnabledCustomTools } from './store';

export {
  type Definition,
  type DefinitionPatch,
  DefinitionPatchSchema,
  DefinitionSchema,
  SLUG_RE,
  checkDefinition,
  confirmationPosture,
} from './definition';
