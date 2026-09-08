import { Panel } from '@/components/ui/panel';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowRight, BookOpen, Braces, Inbox, Server } from 'lucide-react';
import Link from 'next/link';

const paths = [
  {
    title: 'Consultar un archivo ahora',
    description: 'Súbelo al Feed para analizarlo sin convertirlo en memoria permanente.',
    scope: 'Solo tú · temporal',
    action: 'Abrir Feed',
    href: '/feed',
    icon: Inbox,
  },
  {
    title: 'Guardar conocimiento de la empresa',
    description: 'Sube manuales, políticas y documentos que Cortex debe volver a encontrar.',
    scope: 'Empresa · persistente',
    action: 'Abrir Brain Knowledge',
    href: '/kb',
    icon: BookOpen,
  },
  {
    title: 'Conectar una API propia',
    description:
      'Define acciones sobre tu ERP, inventario u otro sistema interno con su documentación.',
    scope: 'Empresa · administrado',
    action: 'Crear herramientas',
    href: '/tools#custom-tools',
    icon: Braces,
  },
  {
    title: 'Agregar un servidor MCP',
    description: 'Importa herramientas de un servidor compatible para usarlas desde tu cuenta.',
    scope: 'Solo tú · avanzado',
    action: 'Configurar MCP',
    href: '/integrations#mcp',
    icon: Server,
  },
] as const;

export function SourceIntake({ workspaceId }: { workspaceId: string }) {
  return (
    <Panel className="mb-5 overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold text-ink">¿Qué quieres traer a Cortex?</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          Elige según el trabajo. El alcance indica quién podrá usar lo que conectes. Los permisos
          de cada persona y agente se siguen aplicando.
        </p>
      </div>
      <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
        {paths.map((path) => (
          <Link
            key={path.title}
            href={workspaceHref(workspaceId, path.href)}
            className="group flex min-h-44 flex-col bg-surface p-4 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
                <path.icon className="h-4 w-4" />
              </span>
              <span className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted">
                {path.scope}
              </span>
            </div>
            <h3 className="mt-3 text-sm font-bold text-ink">{path.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{path.description}</p>
            <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-semibold text-primary">
              {path.action}
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" />
            </span>
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-2 px-4 py-4">
        <div className="max-w-2xl">
          <h3 className="text-sm font-semibold text-ink">Define cómo se usa la información</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Un documento puede servir a varias áreas. Para los documentos ya leídos por Cortex,
            distingue su uso administrativo, financiero, comercial u operativo y revisa su efecto en
            las cifras.
          </p>
        </div>
        <Link
          href={workspaceHref(workspaceId, '/finance#sources')}
          className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Clasificar documentos <ArrowRight size={15} />
        </Link>
      </div>
    </Panel>
  );
}
