import 'server-only';
import {
  type CustomToolRow,
  type Definition,
  type DefinitionPatch,
  checkDefinition,
  confirmationPosture,
  customToolId,
} from '@cortex/agent-tools';
import { encryptToken } from '@cortex/core';

/**
 * The translation layer between the panel's JSON and the `custom_tools` row.
 *
 * It lives outside the route handlers because CREATE and PATCH have to agree
 * about it exactly. A PATCH that mapped one field differently from the POST
 * that created the row is the kind of divergence that shows up months later as
 * "the tool works until you edit it".
 */

/** The camelCase view of a row that the panel consumes. Never carries a secret. */
export interface CustomToolView {
  id: string;
  toolId: string;
  slug: string;
  name: string;
  description: string;
  fields: unknown;
  method: string;
  urlTemplate: string;
  headers: Record<string, string>;
  bodyEncoding: string;
  bodyTemplate: unknown;
  authType: string;
  authHeaderName: string | null;
  authUsername: string | null;
  /** Whether a secret is stored. The secret itself never leaves the database. */
  authConfigured: boolean;
  responsePath: string | null;
  responseMaxChars: number;
  timeoutMs: number;
  allowInsecureHttp: boolean;
  followRedirects: boolean;
  requiresConfirmation: boolean;
  rateLimitPerMinute: number;
  enabled: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What a non-admin member is allowed to see: what the tool is, not how it works. */
export interface CustomToolPublicView {
  id: string;
  toolId: string;
  name: string;
  description: string;
  requiresConfirmation: boolean;
  enabled: boolean;
}

type RowWithAuthFlag = CustomToolRow & { auth_secret_encrypted?: string | null };

export function toView(row: RowWithAuthFlag): CustomToolView {
  return {
    id: row.id,
    toolId: customToolId(row.slug),
    slug: row.slug,
    name: row.name,
    description: row.description,
    fields: row.input_schema?.fields ?? [],
    method: row.http_method,
    urlTemplate: row.url_template,
    headers: (row.headers ?? {}) as Record<string, string>,
    bodyEncoding: row.body_encoding,
    bodyTemplate: row.body_template ?? null,
    authType: row.auth_type,
    authHeaderName: row.auth_header_name,
    authUsername: row.auth_username,
    // Derived from a column the read paths do not select, so this stays a
    // boolean even when the caller did select it.
    authConfigured: row.auth_type !== 'none',
    responsePath: row.response_path,
    responseMaxChars: row.response_max_chars,
    timeoutMs: row.timeout_ms,
    allowInsecureHttp: row.allow_insecure_http,
    followRedirects: row.follow_redirects,
    requiresConfirmation: row.requires_confirmation,
    rateLimitPerMinute: row.rate_limit_per_minute,
    enabled: row.enabled,
    lastTestedAt: row.last_tested_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function toPublicView(row: CustomToolRow): CustomToolPublicView {
  return {
    id: row.id,
    toolId: customToolId(row.slug),
    name: row.name,
    description: row.description,
    requiresConfirmation: row.requires_confirmation,
    enabled: row.enabled,
  };
}

/**
 * Merge a patch onto the stored row and produce a complete definition, so
 * `checkDefinition` always sees the whole picture. Validating a patch in
 * isolation is how you end up storing a URL whose placeholder refers to a field
 * the same request just deleted.
 */
export function mergeIntoDefinition(row: CustomToolRow, patch: DefinitionPatch): Definition {
  return {
    slug: patch.slug ?? row.slug,
    name: patch.name ?? row.name,
    description: patch.description ?? row.description,
    fields: (patch.fields ?? row.input_schema?.fields ?? []) as Definition['fields'],
    method: patch.method ?? row.http_method,
    urlTemplate: patch.urlTemplate ?? row.url_template,
    headers: patch.headers ?? ((row.headers ?? {}) as Record<string, string>),
    bodyEncoding: patch.bodyEncoding ?? row.body_encoding,
    bodyTemplate: 'bodyTemplate' in patch ? patch.bodyTemplate : (row.body_template ?? undefined),
    authType: patch.authType ?? row.auth_type,
    authHeaderName: patch.authHeaderName ?? row.auth_header_name ?? undefined,
    authUsername: patch.authUsername ?? row.auth_username ?? undefined,
    authSecret: patch.authSecret,
    responsePath: patch.responsePath ?? row.response_path ?? undefined,
    responseMaxChars: patch.responseMaxChars ?? row.response_max_chars,
    timeoutMs: patch.timeoutMs ?? row.timeout_ms,
    allowInsecureHttp: patch.allowInsecureHttp ?? row.allow_insecure_http,
    followRedirects: patch.followRedirects ?? row.follow_redirects,
    requiresConfirmation: patch.requiresConfirmation ?? row.requires_confirmation,
    rateLimitPerMinute: patch.rateLimitPerMinute ?? row.rate_limit_per_minute,
    enabled: patch.enabled ?? row.enabled,
  };
}

export interface ToColumnsResult {
  columns: Record<string, unknown>;
  /** Non-fatal note for the admin when a write was left ungated. */
  warning: string | null;
  problems: string[];
}

/**
 * A validated definition as database columns.
 *
 * The secret is encrypted here and nowhere else, and `authSecret: undefined`
 * means "leave whatever is stored alone" — the panel must be able to edit a
 * URL without re-typing an API key it can no longer read.
 */
export function toColumns(def: Definition, opts: { isCreate: boolean }): ToColumnsResult {
  const problems = checkDefinition(def);
  const { requiresConfirmation, warning } = confirmationPosture(def);

  const columns: Record<string, unknown> = {
    slug: def.slug,
    name: def.name,
    description: def.description,
    input_schema: { fields: def.fields },
    http_method: def.method,
    url_template: def.urlTemplate,
    headers: def.headers,
    body_encoding: def.bodyEncoding,
    body_template: def.bodyEncoding === 'none' ? null : (def.bodyTemplate ?? null),
    auth_type: def.authType,
    auth_header_name: def.authType === 'header' ? (def.authHeaderName ?? null) : null,
    auth_username: def.authType === 'basic' ? (def.authUsername ?? null) : null,
    response_path: def.responsePath || null,
    response_max_chars: def.responseMaxChars,
    timeout_ms: def.timeoutMs,
    allow_insecure_http: def.allowInsecureHttp,
    follow_redirects: def.followRedirects,
    requires_confirmation: requiresConfirmation,
    rate_limit_per_minute: def.rateLimitPerMinute,
    enabled: def.enabled,
    updated_at: new Date().toISOString(),
  };

  if (def.authType === 'none') {
    // Switching auth off must drop the stored credential, not orphan it.
    columns.auth_secret_encrypted = null;
  } else if (def.authSecret !== undefined) {
    columns.auth_secret_encrypted = encryptToken(def.authSecret);
  } else if (opts.isCreate) {
    columns.auth_secret_encrypted = null;
  }

  return { columns, warning, problems };
}
