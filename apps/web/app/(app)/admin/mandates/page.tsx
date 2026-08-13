import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  DEFAULT_MANDATE_DAYS,
  type MandateRow,
  daysLeft,
  listMandates,
  listRecentUses,
  mandateState,
} from '@/lib/mandates/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { familyLabel, familyOf, qualifiedToolLabel } from '@/lib/tool-taxonomy';
import { NEVER_DELEGATED_FAMILIES, listTools } from '@cortex/agent-tools';
import { KeyRound, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { GrantForm } from './_components/GrantForm';
import { MandateList } from './_components/MandateList';

export const dynamic = 'force-dynamic';

const USES_WINDOW_DAYS = 30;

/**
 * Mandatos: lo que esta empresa decidió que Cortex puede hacer sin preguntar.
 *
 * La pantalla vive bajo /admin, así que el layout ya la reserva para `org_admin`
 * (apps/web/app/(app)/admin/layout.tsx). El registro de herramientas se resuelve
 * AQUÍ, en un componente de servidor, y baja como props serializables:
 * `@cortex/agent-tools` no puede llegar a un módulo de cliente porque arrastra
 * `node:crypto`, `node:dns` y el acceso a `fs` de pdf-parse al bundle.
 *
 * El tono de todos los textos es deliberado. Esta es la única pantalla del
 * producto donde alguien apaga una pregunta de seguridad, y merece decir sin
 * eufemismos qué se está delegando y hasta cuándo. «Automatizar» y «agilizar»
 * están prohibidos aquí: lo que se hace es AUTORIZAR A ACTUAR SIN PREGUNTAR.
 */
export default async function MandatesPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);

  const since = new Date(Date.now() - USES_WINDOW_DAYS * 86_400_000).toISOString();
  const [mandates, uses] = await Promise.all([listMandates(sb), listRecentUses(sb, since)]);

  const names = await fetchUserNames(
    sb,
    mandates.flatMap((m) => [m.granted_by, m.revoked_by ?? '']),
  );

  const usesByMandate: Record<string, number> = {};
  for (const u of uses) usesByMandate[u.mandate_id] = (usesByMandate[u.mandate_id] ?? 0) + 1;

  // El catálogo delegable de HOY, agrupado por familia. Lo que no aparece aquí
  // no se puede conceder desde ninguna parte de esta pantalla.
  const families = new Map<string, { id: string; label: string }[]>();
  for (const tool of listTools()) {
    if (tool.id.startsWith('test.')) continue;
    const family = familyOf(tool.id);
    if (NEVER_DELEGATED_FAMILIES.includes(family)) continue;
    const list = families.get(family) ?? [];
    list.push({ id: tool.id, label: qualifiedToolLabel(tool.id) });
    families.set(family, list);
  }
  const catalogue = [...families.entries()]
    .map(([family, tools]) => ({
      family,
      label: familyLabel(family),
      tools: tools.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));

  const now = new Date();
  const view = mandates.map((m: MandateRow) => ({
    id: m.id,
    label: m.label,
    reason: m.reason,
    state: mandateState(m, now),
    daysLeft: daysLeft(m, now),
    patterns: m.tool_patterns ?? [],
    covered: (m.covered_tool_ids ?? []).map((id) => ({ id, label: qualifiedToolLabel(id) })),
    maxRiskLevel: m.max_risk_level,
    amountCeiling: m.amount_ceiling === null ? null : Number(m.amount_ceiling),
    currency: m.currency,
    appliesUnattended: m.applies_unattended,
    maxUsesPerDay: m.max_uses_per_day,
    grantedBy: names[m.granted_by] ?? 'alguien que ya no está',
    revokedBy: m.revoked_by ? (names[m.revoked_by] ?? 'un administrador') : null,
    startsAt: m.starts_at,
    expiresAt: m.expires_at,
    revokedAt: m.revoked_at,
    createdAt: m.created_at,
    usesWindow: usesByMandate[m.id] ?? 0,
  }));

  const active = view.filter((m) => m.state === 'active').length;

  return (
    <>
      <PageHeader
        title="Mandatos"
        subtitle="Lo que Cortex puede hacer sin preguntarte: qué, hasta cuánto y hasta cuándo"
        icon={<KeyRound className="h-5 w-5" />}
        actions={
          <Link
            href="/admin/audit?decision=delegated"
            className="inline-flex items-center gap-2 rounded-pill border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
          >
            <ShieldCheck className="h-4 w-4" />
            Ver lo que hizo sin preguntar
          </Link>
        }
      />

      <div className="space-y-4">
        <Panel className="p-4">
          <div className="field-label mb-2">Qué es esto, sin rodeos</div>
          <div className="grid gap-3 text-[12.5px] leading-relaxed text-ink-muted md:grid-cols-2">
            <p>
              Normalmente Cortex se detiene y te pregunta antes de hacer algo que sale de la empresa
              o que toca datos delicados. Un mandato apaga esa pregunta para un conjunto concreto de
              herramientas: a partir de ahí, Cortex <strong className="text-ink">actúa solo</strong>{' '}
              dentro de ese conjunto y tú te enteras después, en la auditoría.
            </p>
            <p>
              Hay cosas que ningún mandato levanta, se conceda como se conceda: nada que la capa de
              seguridad haya <strong className="text-ink">bloqueado</strong>, nada{' '}
              <strong className="text-ink">crítico</strong>, ninguna exportación masiva de datos de
              nómina o personales, ni nada cuyo contenido lleve una cédula, una cuenta bancaria o
              una tabla de salarios. Tampoco las herramientas de seguridad, las de mandatos ni las
              que la empresa se construyó por su cuenta.
            </p>
            <p>
              Todo mandato <strong className="text-ink">caduca</strong> — {DEFAULT_MANDATE_DAYS}{' '}
              días por defecto — y se puede revocar en cualquier momento. La revocación tiene efecto
              en la llamada siguiente, no dentro de un rato.
            </p>
            <p>
              Un mandato cubre las herramientas que existían{' '}
              <strong className="text-ink">el día que se concedió</strong>. Una integración que se
              instale mañana no queda incluida aunque el patrón la nombrara: para actuar sola,
              Cortex necesita que alguien lo haya decidido sobre algo que ya existía.
            </p>
          </div>
        </Panel>

        <GrantForm catalogue={catalogue} defaultDays={DEFAULT_MANDATE_DAYS} />

        <MandateList mandates={view} usesWindowDays={USES_WINDOW_DAYS} activeCount={active} />
      </div>
    </>
  );
}
