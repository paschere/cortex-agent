/**
 * Validating a tool definition BEFORE it is stored.
 *
 * Two audiences, and the split matters. `DefinitionSchema` is a zod schema for
 * the API payload — machine-checkable shape, English identifiers. `checkDefinition`
 * is the part that needs judgement (does every placeholder name a field that
 * exists? is the URL reachable in principle? is a write ungated?) and its
 * messages are Colombian Spanish, because they are rendered next to the form
 * the admin is filling in.
 *
 * Save time is the right moment to be strict about everything except DNS. A
 * hostname that does not resolve yet is a staging environment coming up, not an
 * attack; a hostname of `localhost` is neither, and gets refused here rather
 * than at 2am on a chat turn.
 */

import { z } from 'zod';
import { describeStaticUrlProblem } from './guard';
import { FIELD_NAME_RE } from './schema';
import { isReservedHeader, isValidHeaderName, placeholdersIn } from './template';
import { isWriteMethod } from './types';

export const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

const FieldSchema = z.object({
  name: z.string().regex(FIELD_NAME_RE),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'string_array']),
  required: z.boolean().default(false),
  description: z.string().trim().max(300).default(''),
  enum: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export const DefinitionSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(10).max(1000),
  fields: z.array(FieldSchema).max(30).default([]),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  urlTemplate: z.string().trim().min(8).max(2048),
  headers: z.record(z.string().max(4000)).default({}),
  bodyEncoding: z.enum(['none', 'json', 'form']).default('none'),
  /** Any JSON value. Validated structurally, never parsed from a string of JSON. */
  bodyTemplate: z.unknown().optional(),
  authType: z.enum(['none', 'header', 'bearer', 'basic']).default('none'),
  authHeaderName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  authUsername: z.string().trim().max(200).optional(),
  /** Write-only. Never echoed back by any read path. */
  authSecret: z.string().min(1).max(4000).optional(),
  responsePath: z.string().trim().max(200).optional(),
  responseMaxChars: z.number().int().min(200).max(50_000).default(8_000),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  allowInsecureHttp: z.boolean().default(false),
  followRedirects: z.boolean().default(false),
  requiresConfirmation: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(120).default(20),
  enabled: z.boolean().default(true),
});

export type Definition = z.infer<typeof DefinitionSchema>;

/** A patch is every field optional; the route merges it onto the stored row. */
export const DefinitionPatchSchema = DefinitionSchema.partial();
export type DefinitionPatch = z.infer<typeof DefinitionPatchSchema>;

/**
 * Semantic checks the shape cannot express. Returns Spanish problems for the
 * panel; an empty array means the definition is storable.
 */
export function checkDefinition(def: Definition): string[] {
  const problems: string[] = [];

  const names = new Set<string>();
  for (const field of def.fields) {
    if (names.has(field.name)) {
      problems.push(`El campo "${field.name}" está repetido.`);
    }
    names.add(field.name);
    if (field.enum && field.type !== 'string') {
      problems.push(
        `El campo "${field.name}" solo puede tener opciones fijas si es de tipo texto.`,
      );
    }
    if (!field.description.trim()) {
      // Not fatal, but the model fills an undescribed field with a guess.
      problems.push(
        `El campo "${field.name}" no tiene descripción; sin ella el modelo adivina qué poner ahí.`,
      );
    }
  }

  const urlProblem = describeStaticUrlProblem(
    // Placeholders are not valid URL characters in every position, so the URL
    // is checked with them replaced by a harmless token. What matters at save
    // time is the scheme and the host, and neither can come from a placeholder:
    // a template whose HOST is variable would make the destination check
    // meaningless, so that is rejected below.
    def.urlTemplate.replaceAll(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, 'x'),
    def.allowInsecureHttp,
  );
  if (urlProblem) problems.push(urlProblem);

  // The host must be fixed. If it could be interpolated, an admin could publish
  // a tool whose destination the MODEL chooses, and the model takes its
  // instructions from whatever text it has been reading.
  const hostPart = def.urlTemplate.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
  if (/\{\{/.test(hostPart)) {
    problems.push(
      'El dominio de la URL no puede tener campos variables: solo la ruta y los parámetros. Si el destino cambiara según lo que escriba el usuario, la validación de seguridad no serviría de nada.',
    );
  }

  for (const [name, value] of Object.entries(def.headers)) {
    if (!isValidHeaderName(name)) {
      problems.push(`"${name}" no es un nombre de cabecera válido.`);
    } else if (isReservedHeader(name)) {
      problems.push(`La cabecera "${name}" la maneja Cortex y no se puede definir aquí.`);
    }
    if (/[\r\n]/.test(value)) {
      problems.push(`La cabecera "${name}" no puede contener saltos de línea.`);
    }
    if (name.toLowerCase() === 'authorization' && def.authType !== 'none') {
      problems.push(
        'No definas la cabecera "Authorization" a mano si ya configuraste autenticación: se pisarían entre sí.',
      );
    }
  }

  // Every placeholder must name a declared field. A typo here is the failure
  // mode that is hardest to see later: the request goes out with an empty
  // segment and the API answers 404 for reasons nobody can explain.
  const used = new Set<string>([
    ...placeholdersIn(def.urlTemplate),
    ...placeholdersIn(def.headers),
    ...(def.bodyEncoding === 'none' ? [] : placeholdersIn(def.bodyTemplate ?? null)),
  ]);
  for (const name of used) {
    if (!names.has(name)) {
      problems.push(`La plantilla usa {{${name}}}, pero no existe un campo con ese nombre.`);
    }
  }

  if (def.authType === 'header' && !def.authHeaderName) {
    problems.push('Falta el nombre de la cabecera donde va la llave.');
  }
  if (def.authType === 'basic' && !def.authUsername) {
    problems.push('La autenticación básica necesita un usuario.');
  }
  if (def.bodyEncoding !== 'none' && def.bodyTemplate === undefined) {
    problems.push('Elegiste enviar un cuerpo, pero no definiste su contenido.');
  }
  if (def.bodyEncoding === 'form') {
    const ok =
      def.bodyTemplate !== null &&
      typeof def.bodyTemplate === 'object' &&
      !Array.isArray(def.bodyTemplate);
    if (!ok) {
      problems.push('Un cuerpo de tipo formulario tiene que ser un objeto plano de campos.');
    }
  }
  if (def.bodyEncoding !== 'none' && def.method === 'GET') {
    problems.push('Una petición GET no lleva cuerpo.');
  }

  return problems;
}

/**
 * The confirmation posture for a definition, and the sentence that explains it.
 *
 * A tool that writes asks by default. An admin may turn that off — some
 * integrations exist precisely to be automatic — but the switch has to say what
 * it costs, because the person flipping it is deciding that the agent may
 * change data in their ERP with nobody watching.
 */
export function confirmationPosture(def: {
  method: string;
  requiresConfirmation?: boolean;
}): { requiresConfirmation: boolean; warning: string | null } {
  const writes = isWriteMethod(def.method);
  // Undefined means "not stated": writes default to gated, reads to ungated.
  const requested = def.requiresConfirmation;
  const requiresConfirmation = requested === undefined ? writes : requested;

  if (writes && !requiresConfirmation) {
    return {
      requiresConfirmation,
      warning:
        'Esta herramienta escribe en un sistema externo y quedó SIN confirmación: Cortex va a poder ejecutarla sola, también en rutinas programadas donde no hay nadie mirando. Cada ejecución queda en la auditoría, pero nadie la aprueba antes.',
    };
  }
  return { requiresConfirmation, warning: null };
}
