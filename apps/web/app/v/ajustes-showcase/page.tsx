import { MODULES } from '@cortex/agent-tools/src/modules/catalog';
import { notFound } from 'next/navigation';
import { AjustesFixture } from './Showcase';

/**
 * AJUSTES CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /settings pide sesión; aquí se pinta el mismo recibidor (registro, filtros y
 * componentes reales) con una empresa de mentira. Vive bajo `/v` por la misma
 * razón que /v/modulos-showcase. En producción responde 404.
 *
 * Parámetros: `?rol=miembro|fundador`, `?apagados=1` (nómina y piloto
 * apagados), `?q=texto` (búsqueda), `?abrir=notificaciones|correo`,
 * `?modo=oscuro`.
 */
export const dynamic = 'force-dynamic';

export default async function AjustesShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const rol = one('rol');
  const off = new Set(one('apagados') === '1' ? ['payroll', 'autopilot', 'sst'] : []);
  return (
    <AjustesFixture
      dark={one('modo') === 'oscuro'}
      admin={rol !== 'miembro' && rol !== 'fundador'}
      teamManager={rol !== 'miembro'}
      modulesOn={MODULES.filter(
        (m) => !off.has(m.key) && (m.defaultOn || m.key === 'inventory'),
      ).map((m) => m.key)}
      query={one('q') ?? ''}
      open={one('abrir')}
    />
  );
}
