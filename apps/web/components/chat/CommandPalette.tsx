'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface Entry {
  href: string;
  label: string;
  /** Extra words the fuzzy search should match, for pages people rename in their head. */
  keywords: string;
}

const NAVIGATION: Entry[] = [
  { href: '/dashboard', label: 'Panel', keywords: 'dashboard inicio resumen home overview' },
  { href: '/chat', label: 'Chat nuevo', keywords: 'cortex preguntar nueva conversacion ask' },
  {
    href: '/conversations',
    label: 'Conversaciones',
    keywords: 'historial hilos transcripciones history',
  },
  { href: '/approvals', label: 'Aprobaciones', keywords: 'pendientes confirmar approvals' },
  {
    href: '/kb',
    label: 'Brain Knowledge',
    keywords: 'kb conocimiento documentos cerebro buscar brain search',
  },
  { href: '/agents', label: 'Agentes', keywords: 'bots agents equipo' },
  {
    href: '/orchestrator',
    label: 'Orquestador',
    keywords: 'plan grafo multiagente ejecutar orchestrator',
  },
  { href: '/pipelines', label: 'Flujos', keywords: 'pipelines manuales playbooks workflows' },
  { href: '/schedules', label: 'Rutinas', keywords: 'programadas tareas cron routines' },
  {
    href: '/settings',
    label: 'Configuración',
    keywords: 'ajustes preferencias zona horaria settings',
  },
];

const CONNECTIONS: Entry[] = [
  {
    href: '/integrations',
    label: 'Integraciones — a qué está conectado Cortex',
    keywords: 'google hubspot slack github linear payroll mcp servers',
  },
  {
    href: '/mcp-tokens',
    label: 'Conectar Claude — usa Cortex desde un cliente de IA',
    keywords: 'claude code chatgpt mcp connector url token oauth',
  },
];

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  if (!open) return null;

  const go = (href: string) => {
    router.push(href);
    onClose();
  };

  const item = (e: Entry) => (
    <Command.Item
      key={e.href}
      value={`${e.label} ${e.keywords}`}
      onSelect={() => go(e.href)}
      className="cursor-pointer rounded-sm px-3 py-2 text-[13px] text-ink-muted transition-colors duration-150 aria-selected:bg-primary-soft aria-selected:text-primary-ink hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
    >
      {e.label}
    </Command.Item>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 pt-[20vh] backdrop-blur-sm"
      // Close on backdrop click only — comparing target to currentTarget avoids
      // needing a stopPropagation handler on the panel itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* No role="dialog"/aria-modal here: nothing traps focus inside the
          palette, and claiming modality that is not enforced misleads a screen
          reader more than the missing role does. */}
      <div className="w-full max-w-lg px-4">
        {/* A dialog genuinely floats above the page — one of the few places
            elevation is earned. */}
        <Command className="overflow-hidden rounded-card border border-border bg-surface shadow-pop">
          <Command.Input
            aria-label="Buscar un comando"
            placeholder="Escribe un comando o busca…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:bg-primary-soft/40 motion-reduce:transition-none"
          />
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="py-4 text-center text-[13px] text-ink-faint">
              Sin resultados.
            </Command.Empty>
            <Command.Group
              heading="Navegación"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-faint"
            >
              {NAVIGATION.map(item)}
            </Command.Group>
            <Command.Group
              heading="Conexiones"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-faint"
            >
              {CONNECTIONS.map(item)}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
