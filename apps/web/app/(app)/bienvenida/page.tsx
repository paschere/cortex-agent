import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { readWelcomeFacts } from '@/lib/team/invitation-landing';
import {
  invitationRoleBlurb,
  invitationRoleLabel,
  normalizeInvitationRole,
} from '@/lib/team/invitation-roles';
import { workspaceHref } from '@/lib/workspace-context';
import {
  ArrowRight,
  CalendarCheck,
  Mail,
  MessageSquare,
  PartyPopper,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bienvenida · Cortex' };

/**
 * LA BIENVENIDA DE QUIEN ENTRA INVITADO.
 *
 * Aceptar una invitación aterrizaba en el producto a secas: ninguna palabra de
 * quién te invitó, con qué rol entraste ni por dónde empezar. Esta pantalla es
 * pequeña a propósito — quién te invitó, tu rol, tres primeros pasos — y se
 * llega a ella una vez, justo después de aceptar (`/api/invitations/<id>/respond`
 * manda aquí con `?inv=`). No es un tour ni un paso obligatorio: cualquier
 * entrada del menú sigue ahí.
 *
 * El id de la invitación sólo cuenta si es de ESTA empresa, de ESTE correo y
 * está aceptada (`readWelcomeFacts`); con cualquier otro id la pantalla sale
 * igual de útil pero sin hablar de nadie.
 */
export default async function WelcomePage({
  searchParams,
}: { searchParams: Promise<{ inv?: string }> }) {
  const { inv } = await searchParams;
  const user = await requireSession();
  const facts = inv
    ? await readWelcomeFacts({
        invitationId: inv,
        organizationId: user.organization.id,
        email: user.email,
      })
    : null;
  const role = normalizeInvitationRole(facts?.role ?? user.organization.role);
  const first = (user.name ?? '').trim().split(/\s+/)[0] ?? '';
  const href = (path: string) => workspaceHref(user.organization.id, path);

  const steps = [
    {
      icon: UserRound,
      title: 'Completa tu perfil',
      text: 'Tu nombre y cómo prefieres que Cortex te hable.',
      href: href('/settings'),
      cta: 'Abrir ajustes',
    },
    {
      icon: Mail,
      title: 'Conecta tu correo (opcional)',
      text: 'Para que Cortex lea y redacte con tu bandeja. Tú decides qué puede hacer.',
      href: href('/integrations'),
      cta: 'Conectar',
    },
    {
      icon: CalendarCheck,
      title: 'Mira «Mi semana»',
      text: 'Lo que tienes pendiente y lo que ya sacaste adelante, en un solo lugar.',
      href: href('/team/yo'),
      cta: 'Ver mi semana',
    },
    {
      icon: MessageSquare,
      title: 'Habla con Cortex',
      text: 'Pregúntale lo que no sepas de la empresa o pídele que haga algo rutinario.',
      href: href('/chat'),
      cta: 'Abrir el chat',
    },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={
          first
            ? `Ya estás en ${user.organization.name}, ${first}`
            : `Ya estás en ${user.organization.name}`
        }
        subtitle={
          facts
            ? `${facts.inviterName} te invitó a trabajar con Cortex. Esto es lo que necesitas saber para empezar.`
            : 'Ya estás adentro. Esto es lo que necesitas saber para empezar.'
        }
        icon={<PartyPopper className="h-5 w-5" aria-hidden />}
      />

      <Panel className="mb-5 p-6">
        <div className="field-label">Tu lugar aquí</div>
        <p className="mt-1.5 text-base font-semibold text-ink">
          {invitationRoleLabel(role)}
          {facts?.position ? ` · ${facts.position}` : ''}
          {facts?.teamName ? ` · equipo ${facts.teamName}` : ''}
        </p>
        <p className="mt-1 text-sm text-ink-muted">{invitationRoleBlurb(role)}</p>
        {facts?.message && (
          <blockquote className="mt-4 whitespace-pre-line rounded-sm border-l-4 border-primary bg-primary-soft px-4 py-3 text-sm leading-snug text-ink">
            <span className="field-label mb-1 block">Mensaje de {facts.inviterName}</span>
            {facts.message}
          </blockquote>
        )}
      </Panel>

      <Panel className="p-2">
        <h2 className="px-4 pb-1 pt-4 text-base font-bold text-ink">Tus primeros pasos</h2>
        <ol className="divide-y divide-border">
          {steps.map((step, index) => (
            <li key={step.title} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                <step.icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  <span className="tabular mr-1.5 text-ink-faint">{index + 1}.</span>
                  {step.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{step.text}</p>
              </div>
              <Link
                href={step.href}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 py-1.5 text-xs font-bold text-ink transition-colors hover:bg-surface-2"
              >
                {step.cta}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ol>
      </Panel>

      <p className="mt-5 text-center text-xs text-ink-faint">
        Esta pantalla no vuelve a salir sola. Todo lo que ves aquí está también en el menú.
      </p>
    </div>
  );
}
