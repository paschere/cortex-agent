import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { ArrowRight, Lock } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sin acceso · Cortex' };

/**
 * LA PARED QUE DICE A QUIÉN TOCAR.
 *
 * Aquí llega quien abre una parte de administración sin serlo. En vez de un
 * 404 («no existe», que es mentira) dice que la parte existe, que la maneja
 * quien administra la empresa, y nombra a esas personas con su correo para que
 * pedir acceso sea un mensaje y no una investigación.
 *
 * Sólo nombres y correos de quienes ya administran la misma empresa: es lo que
 * cualquier compañero ve en la lista del equipo. Nada del contenido protegido.
 */
/** Qué parte se quiso abrir, para que el aviso no hable de «personas y equipos» a quien abrió otra cosa. */
const AREAS: Record<string, string> = {
  admin: 'Personas, equipos, uso, auditoría y seguridad',
  avanzado: 'El orquestador, el trabajo de desarrollo y las evaluaciones',
};

export default async function NoAccessPage({
  searchParams,
}: { searchParams: Promise<{ area?: string }> }) {
  const { area } = await searchParams;
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);
  const admins = mustReadList(
    await sb
      .from('users')
      .select('id, name, email')
      .eq('role', 'org_admin')
      .order('created_at')
      .limit(5),
    'quién administra esta empresa',
  ) as Array<{ id: string; name: string | null; email: string }>;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Esta parte es de quien administra"
        subtitle={`${AREAS[area ?? ''] ?? AREAS.admin} de ${user.organization.name} los maneja quien administra la empresa en Cortex. Tu cuenta no tiene ese permiso, y no pasa nada: todo lo demás sigue disponible.`}
        icon={<Lock className="h-5 w-5" aria-hidden />}
      />
      <Panel className="p-6">
        <h2 className="text-base font-bold text-ink">
          {admins.length > 0 ? 'Pídeselo a' : 'Todavía nadie administra esta empresa'}
        </h2>
        {admins.length > 0 ? (
          <ul className="mt-3 divide-y divide-border">
            {admins.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink">
                    {a.name?.trim() || a.email}
                  </div>
                  <div className="truncate font-mono text-micro text-ink-faint">{a.email}</div>
                </div>
                <a
                  href={`mailto:${a.email}?subject=${encodeURIComponent('Acceso a la administración de Cortex')}`}
                  className="inline-flex min-h-9 items-center rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-sm font-bold text-ink transition-colors hover:bg-surface-2"
                >
                  Escribirle
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Quien creó la cuenta de la empresa puede darte el permiso desde Equipo.
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
          <Link
            href="/dashboard"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white hover:bg-primary-strong"
          >
            Volver al Inicio <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/chat"
            className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-5 py-2 text-sm font-bold text-ink hover:bg-surface-2"
          >
            Preguntarle a Cortex
          </Link>
        </div>
      </Panel>
    </div>
  );
}
