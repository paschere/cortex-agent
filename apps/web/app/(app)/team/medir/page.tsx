import { MeasureSettings } from '@/components/team/MeasureSettings';
import { OverdueDigestToggle } from '@/components/team/OverdueDigestToggle';
import { pillLink } from '@/components/team/pieces';
import type { TrackerOption } from '@/components/team/types';
import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isFounder, managesTeam, teamHrefs } from '@/lib/team/read';
import { CONNECT_WORK_PROMPT, chatPath } from '@/lib/team/shape';
import { workspaceHref } from '@/lib/workspace-context';
import {
  listTrackers,
  listWorkItems,
  readOverdueDigestEnabled,
  readWorkSettings,
} from '@cortex/agent-tools';
import { ArrowLeft, MessageSquareText, Ruler } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { setOverdueDigest } from '../actions';
import { TEAM_ACTIONS } from '../team-actions';

export const dynamic = 'force-dynamic';

/**
 * «QUÉ SE MIDE»: conectar tablas como trabajo, qué tipos se miden y quién ve
 * qué. Sólo quien administra o es dueño de la empresa; los demás vuelven a
 * «Equipo».
 */
export default async function TeamMeasurePage() {
  const user = await requireSession();
  const hrefs = teamHrefs(user.organization.id, { founder: isFounder(user) });
  if (!managesTeam(user)) redirect(hrefs.team({ periodo: 'semana', tipo: null }));
  const db = getOrgScopedClient(user.organization.id);
  const [settings, trackers, { items }, digestOn] = await Promise.all([
    readWorkSettings(db),
    listTrackers(db, 60),
    listWorkItems(db, { limit: 2000 }),
    // El interruptor de los recordatorios (0177). Si no se puede leer, se pinta
    // encendido, que es el valor por defecto de la columna.
    readOverdueDigestEnabled(db).catch(() => true),
  ]);
  const mappedAs = new Map(settings.trackerMappings.map((m) => [m.tracker, m.workType]));
  const options: TrackerOption[] = trackers.map((t) => ({
    slug: t.slug,
    name: t.name,
    rowCount: t.rowCount,
    fields: t.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.options ? { options: f.options } : {}),
    })),
    mappedAs: mappedAs.get(t.slug) ?? null,
  }));
  const workTypes = [
    ...new Set([
      ...items.map((i) => i.workType),
      ...settings.trackerMappings.map((m) => m.workType),
    ]),
  ].sort((a, b) => a.localeCompare(b, 'es'));

  return (
    <>
      <Link
        href={hrefs.team({ periodo: 'semana', tipo: null })}
        className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Equipo
      </Link>
      <PageHeader
        title="Qué se mide"
        subtitle="De dónde sale el trabajo del equipo, qué tipos cuentan y quién ve qué. Cortex ya lee solo los casos de Gerencia, los compromisos y las aprobaciones; aquí conectas tus propias tablas."
        icon={<Ruler className="h-5 w-5" />}
        actions={
          <Link
            href={workspaceHref(user.organization.id, chatPath(CONNECT_WORK_PROMPT))}
            className={pillLink}
          >
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
            Hacerlo en el chat
          </Link>
        }
      />
      <MeasureSettings
        trackers={options}
        workTypes={workTypes}
        measuredTypes={settings.measuredTypes}
        visibility={settings.teamVisibility}
        actions={TEAM_ACTIONS}
      />
      <OverdueDigestToggle initial={digestOn} save={setOverdueDigest} />
    </>
  );
}
