import { DefinitionSchema, checkDefinition } from '@cortex/agent-tools';

/** Generated configuration is a disabled draft, never an authority grant. */
export function validatePreparedTool(raw: unknown, apiUrl: string) {
  // Models sometimes emit empty optional fields even when asked to omit them.
  // Required authentication metadata is still checked by checkDefinition below.
  const normalized =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ({ ...raw } as Record<string, unknown>)
      : raw;
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    for (const key of ['authHeaderName', 'authUsername', 'authSecret', 'responsePath']) {
      const value = (normalized as Record<string, unknown>)[key];
      if (value == null || (typeof value === 'string' && !value.trim()))
        delete (normalized as Record<string, unknown>)[key];
    }
  }
  const candidate = DefinitionSchema.parse(normalized);
  const base = new URL(apiUrl);
  const target = new URL(candidate.urlTemplate.replace(/\{\{[^}]+\}\}/g, 'sample'));
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Usa una URL HTTPS de la API, sin credenciales ni parámetros.');
  if (target.origin !== base.origin)
    throw new Error('La operación propuesta debe pertenecer al dominio de tu API.');
  const draft = {
    ...candidate,
    authSecret: undefined,
    authUsername: candidate.authType === 'basic' ? 'COMPLETAR_USUARIO' : undefined,
    headers: Object.fromEntries(
      Object.entries(candidate.headers).filter(([name]) =>
        ['accept', 'content-type'].includes(name.toLowerCase()),
      ),
    ),
    enabled: false,
    requiresConfirmation: true,
    allowInsecureHttp: false,
    followRedirects: false,
    timeoutMs: 10000,
    rateLimitPerMinute: 20,
  };
  const problems = checkDefinition(draft);
  if (problems.length) throw new Error(problems.join(' '));
  return { ...draft, authUsername: undefined };
}
