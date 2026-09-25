import { clsx } from 'clsx';
import { Building2, Users } from 'lucide-react';
import Link from 'next/link';

/**
 * Las secciones de la consola del fundador.
 *
 * Enlaces y no pestañas de Radix: cada sección es una ruta con sus propias
 * lecturas en el servidor, así que se puede abrir, recargar y compartir por
 * separado. «Personas» sólo aparece si la cuenta dirige alguna empresa.
 */
export function FounderTabs({
  current,
  showPeople,
}: {
  current: 'companies' | 'people';
  showPeople: boolean;
}) {
  const tabs = [
    { id: 'companies', href: '/overview', label: 'Empresas', Icon: Building2 },
    ...(showPeople
      ? [{ id: 'people', href: '/overview/people', label: 'Personas', Icon: Users }]
      : []),
  ] as const;
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Consola del fundador" className="mb-6 flex gap-1 border-b border-border">
      {tabs.map(({ id, href, label, Icon }) => (
        <Link
          key={id}
          href={href}
          aria-current={current === id ? 'page' : undefined}
          className={clsx(
            '-mb-px inline-flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            current === id
              ? 'border-primary text-ink'
              : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
