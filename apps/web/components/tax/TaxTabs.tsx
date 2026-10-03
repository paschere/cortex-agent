import { clsx } from 'clsx';
import Link from 'next/link';
import type { TaxTab, TaxTabLinks } from './types';

/**
 * Las pestañas de /impuestos (0197): el calendario, los certificados de
 * retención a proveedores y la preparación de la exógena. Enlaces de verdad
 * (cada una es su ruta), así que se pueden abrir en otra pestaña y compartir.
 */
const TABS: Array<{ id: TaxTab; label: string }> = [
  { id: 'calendario', label: 'Calendario' },
  { id: 'certificados', label: 'Certificados de retención' },
  { id: 'exogena', label: 'Exógena' },
];

export function TaxTabs({ active, links }: { active: TaxTab; links: TaxTabLinks }) {
  return (
    <nav
      aria-label="Secciones de impuestos"
      className="mb-5 flex flex-wrap gap-1.5 border-b border-border"
    >
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={links[t.id]}
          aria-current={t.id === active ? 'page' : undefined}
          className={clsx(
            '-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-semibold transition-colors',
            t.id === active
              ? 'border-primary text-ink'
              : 'border-transparent text-ink-muted hover:border-border hover:text-ink',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
