/**
 * The shape of a user-defined tool, as it lives in `custom_tools` (0067) and as
 * the rest of this folder passes it around.
 *
 * Everything here is DATA. A custom tool is a description of a request, never a
 * fragment of code: nothing in this package compiles, evaluates or `new
 * Function`s anything a user typed. The input schema becomes a zod object by
 * construction (schema.ts) and the request becomes a URL/headers/body by
 * substitution (template.ts).
 */

/**
 * Field types a creator can pick. Deliberately small: these are the types that
 * map cleanly onto both a zod validator and a JSON body, and every extra one is
 * a new way for a form to produce something an API will not accept.
 */
export type CustomToolFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'string_array';

export interface CustomToolField {
  /** Referenced from templates as `{{name}}`, and shown to the model verbatim. */
  name: string;
  type: CustomToolFieldType;
  required: boolean;
  /** Read by the model. "Número de la guía, 10 dígitos" beats "id". */
  description: string;
  /** Optional closed set, `string` fields only. */
  enum?: string[];
}

export interface CustomToolInputSchema {
  fields: CustomToolField[];
}

export type CustomToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type CustomToolAuthType = 'none' | 'header' | 'bearer' | 'basic';

export type CustomToolBodyEncoding = 'none' | 'json' | 'form';

/** The methods that change something on the other end. */
export const WRITE_METHODS: readonly CustomToolMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isWriteMethod(method: string): boolean {
  return (WRITE_METHODS as readonly string[]).includes(method.toUpperCase());
}

/** A row of `custom_tools`, snake_cased exactly as Postgres returns it. */
export interface CustomToolRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  input_schema: CustomToolInputSchema | null;
  http_method: CustomToolMethod;
  url_template: string;
  headers: Record<string, string> | null;
  body_encoding: CustomToolBodyEncoding;
  body_template: unknown;
  auth_type: CustomToolAuthType;
  auth_header_name: string | null;
  auth_username: string | null;
  auth_secret_encrypted: string | null;
  response_path: string | null;
  response_max_chars: number;
  timeout_ms: number;
  allow_insecure_http: boolean;
  follow_redirects: boolean;
  requires_confirmation: boolean;
  rate_limit_per_minute: number;
  enabled: boolean;
  created_by?: string | null;
  last_tested_at?: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * The columns the panel is allowed to read back. `auth_secret_encrypted` is
 * absent on purpose — see `SAFE_COLUMNS`.
 */
export interface CustomToolSummary extends Omit<CustomToolRow, 'auth_secret_encrypted'> {
  /** Whether a secret is stored, which is all the panel ever needs to know. */
  authConfigured: boolean;
  /** `custom.<slug>` — the id this tool runs under. */
  toolId: string;
}

/**
 * The one prefix user-defined tools live under.
 *
 * WHY A PREFIX AND NOT A FLAT NAMESPACE. Registry ids are `family.action`, and
 * families are added by us, in code. If a customer could name a tool
 * `gmail.send_draft` it would shadow — or be shadowed by, depending on map
 * insertion order — a tool with a completely different meaning and a
 * completely different risk classification. Reserving `custom.` makes the
 * collision impossible by construction rather than by review, and it keeps the
 * whole population greppable in the audit trail: every row whose tool_id starts
 * with `custom.` went somewhere a customer pointed us.
 */
export const CUSTOM_TOOL_PREFIX = 'custom.';

/** The family every custom tool reports to tool-selection and to the risk model. */
export const CUSTOM_TOOL_FAMILY = 'custom';

export function customToolId(slug: string): string {
  return `${CUSTOM_TOOL_PREFIX}${slug}`;
}

/** The columns any read path may select. Note what is missing. */
export const SAFE_COLUMNS =
  'id, organization_id, slug, name, description, input_schema, http_method, url_template, headers, body_encoding, body_template, auth_type, auth_header_name, auth_username, response_path, response_max_chars, timeout_ms, allow_insecure_http, follow_redirects, requires_confirmation, rate_limit_per_minute, enabled, created_by, last_tested_at, last_error, created_at, updated_at';

/** Same, plus the encrypted secret. Only the executor and the tester use it. */
export const EXECUTION_COLUMNS = `${SAFE_COLUMNS}, auth_secret_encrypted`;

/**
 * The result every custom tool returns. It NEVER throws — a 500 from a
 * customer's ERP, an expired API key and a timeout are ordinary operating
 * conditions of somebody else's system, not bugs in ours, and a thrown error
 * would abort the whole turn instead of letting the agent say what happened.
 * Same contract as the vehicles client.
 */
export interface CustomToolResult {
  ok: boolean;
  /** HTTP status, or null when the request never got that far. */
  status: number | null;
  /** The selected slice of the response. Present when `ok`. */
  data?: unknown;
  /** True when `data` was cut to fit `response_max_chars`. */
  truncated?: boolean;
  /** A sentence the model can relay. Present when `ok` is false. */
  message?: string;
}

/** How many custom tools one workspace may define. */
export const MAX_TOOLS_PER_ORG = 40;
