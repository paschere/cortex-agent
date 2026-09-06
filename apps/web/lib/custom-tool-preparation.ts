import { DefinitionSchema, checkDefinition } from '@cortex/agent-tools';

/** Generated configuration is a disabled draft, never an authority grant. */
export function validatePreparedTool(raw: unknown, apiUrl: string) {
  const candidate = DefinitionSchema.parse(raw);
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
