'use client';

import { clsx } from 'clsx';
import { useEffect, useState } from 'react';

/**
 * EL ÍNDICE DE LA PÁGINA, y por qué una pantalla de ajustes lo necesita.
 *
 * /settings era una sola columna de siete paneles: para llegar a «lo que Cortex
 * recuerda de ti» había que pasar por el webhook de Google Chat, y para volver a
 * guardar había que subir otra vez. Una pantalla que se recorre entera cada vez
 * que se quiere tocar una cosa es una pantalla que se toca poco.
 *
 * SON ANCLAS, NO PESTAÑAS, y la diferencia importa: la página sigue siendo una
 * sola —se puede buscar con Ctrl+F, imprimir, o enlazar `/settings#correo` desde
 * cualquier sitio— y sin JavaScript los enlaces siguen llevando a su sección.
 * Lo único que aporta el cliente es saber en cuál estás, que es adorno útil y no
 * el mecanismo.
 */

export interface NavSection {
  id: string;
  label: string;
}

export function SettingsNav({ sections }: { sections: NavSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? '');

  useEffect(() => {
    const nodes = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;

    // La franja de arriba de la ventana: la sección activa es la primera que
    // cruza esa línea, y no «la que más se ve». Con paneles de alturas muy
    // distintas —el de correo mide una cuarta parte del de resumen— el criterio
    // por área hace que el índice salte hacia atrás al bajar, que es peor que no
    // resaltar nada.
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit?.target.id) setActive(hit.target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Secciones de configuración" className="lg:sticky lg:top-6">
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? 'true' : undefined}
              className={clsx(
                'block whitespace-nowrap rounded-sm px-3 py-2 text-sm transition-colors',
                active === s.id
                  ? 'bg-primary-soft font-semibold text-primary'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
