import { readPeriodKey } from '@/lib/team/shape';
import { notFound } from 'next/navigation';
import { EquipoFixture } from './Showcase';
import { FIXTURE_TRACKERS, type ShowcaseParams, fixturePerson, fixtureTeam } from './data';

/**
 * «EQUIPO» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /team pide sesión; aquí se pintan las mismas pantallas (components/team)
 * con Logística Andina S.A.S. (packages/agent-tools/src/work/metrics.fixtures.ts),
 * calculada con el motor de verdad. Vive bajo `/v` por la misma razón que
 * /v/finanzas-showcase: el prefijo ya es público y un segmento estático gana
 * a `/v/[token]`.
 *
 * Parámetros: `?pantalla=equipo|persona|semana|medir`, `?persona=u-laura`,
 * `?periodo=semana|pasada|30d`, `?tipo=despacho`, `?rol=miembro` (alguien que
 * sólo se ve a sí mismo), `?vacia=1` (empresa sin trabajo conectado),
 * `?modo=oscuro`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function EquipoShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const raw = one('pantalla');
  const pantalla: ShowcaseParams['pantalla'] =
    raw === 'persona' || raw === 'semana' || raw === 'medir' ? raw : 'equipo';
  const p: ShowcaseParams = {
    pantalla,
    persona: one('persona') ?? 'u-laura',
    periodo: readPeriodKey(one('periodo')),
    tipo: one('tipo'),
    miembro: one('rol') === 'miembro',
    vacia: one('vacia') === '1',
    modo: one('modo'),
  };
  return (
    <EquipoFixture
      dark={p.modo === 'oscuro'}
      pantalla={pantalla}
      team={pantalla === 'equipo' ? fixtureTeam(p) : null}
      person={
        pantalla === 'persona' || pantalla === 'semana'
          ? fixturePerson(p, pantalla === 'semana')
          : null
      }
      trackers={FIXTURE_TRACKERS}
    />
  );
}
