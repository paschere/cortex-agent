import { Building2 } from 'lucide-react';

/**
 * Los controles chicos que viven dentro de las tarjetas del recibidor y no
 * merecen pantalla propia. Sin estado: se arman en el servidor.
 */

/** Cómo se llama cada papel en la empresa, en español y sin jerga de sistema. */
export const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Administración del espacio',
  team_admin: 'Lidera un equipo',
  member: 'Miembro del equipo',
};

function Fact({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="field-label">{label}</dt>
      <dd className="mt-1 flex items-center gap-1.5 text-sm text-ink">
        {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
        <span className={mono ? 'tabular truncate' : 'truncate'}>{value}</span>
      </dd>
    </div>
  );
}

export function ProfileFacts({
  name,
  email,
  workspace,
  role,
}: {
  name: string | null;
  email: string;
  workspace: string;
  role: string;
}) {
  return (
    <>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label="Nombre" value={name?.trim() || 'Sin nombre'} />
        <Fact label="Correo" value={email} mono />
        <Fact
          label="Espacio de trabajo"
          value={workspace}
          icon={<Building2 className="h-3.5 w-3.5" />}
        />
        <Fact label="Tu papel aquí" value={ROLE_LABEL[role] ?? role} />
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        El nombre y el correo salen de tu cuenta de Google y no se cambian desde aquí. Si perteneces
        a dos empresas, cada una tiene su propia configuración: ésta es la de{' '}
        <span className="font-semibold text-ink-muted">{workspace}</span>.
      </p>
    </>
  );
}

const LEGAL: Array<{ href: string; label: string }> = [
  { href: '/privacidad', label: 'Privacidad' },
  { href: '/tratamiento-de-datos', label: 'Tratamiento de datos' },
  { href: '/terminos', label: 'Términos' },
  { href: '/cookies', label: 'Cookies' },
];

export function LegalLinks() {
  return (
    <ul className="flex flex-wrap gap-2">
      {LEGAL.map((l) => (
        <li key={l.href}>
          <a
            href={l.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex rounded-pill border border-border bg-surface px-3.5 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:border-primary/30 hover:text-primary"
          >
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function VersionInfo({ sha, env }: { sha: string | null; env: string }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <Fact label="Versión" value={sha ? sha.slice(0, 7) : 'Desarrollo'} mono />
      <Fact label="Entorno" value={env} />
    </dl>
  );
}
