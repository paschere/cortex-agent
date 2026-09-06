import { browserActorKey } from '@cortex/agent-tools/src/browser/profiles';
import type { requireSession } from './session';

export async function browserService(
  session: Awaited<ReturnType<typeof requireSession>>,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  if (!base || !token) throw new Error('El navegador de Cortex no está configurado.');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-cortex-owner': browserActorKey(session.organization.id, session.id),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
    cache: 'no-store',
  });
  if (res.status === 422) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      typeof detail?.error === 'string' ? detail.error : 'No se pudo completar el gesto.',
    );
  }
  if (!res.ok)
    throw new Error(
      res.status === 503 || res.status === 429
        ? 'El perfil está en uso o el navegador está ocupado. Cierra su pestaña antes de volver a abrirlo.'
        : res.status === 404
          ? 'La sesión se cerró o ya no tienes acceso.'
          : 'El navegador no pudo completar la solicitud.',
    );
  return res.json();
}
