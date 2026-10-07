'use client';

import type { AppPermissions } from '@cortex/agent-tools';
import {
  BadgeCheck,
  BarChart3,
  Calendar,
  Camera,
  ClipboardPlus,
  Home,
  LayoutPanelTop,
  ListChecks,
  type LucideIcon,
  Package,
  Table2,
  Truck,
  Users,
} from 'lucide-react';

/**
 * Lo común del editor de aplicaciones: los datos que baja el servidor, los
 * iconos de pantalla y las clases de los controles. Los tipos de permisos
 * entran como `import type`: el barril de agent-tools no puede llegar al
 * bundle del navegador (arrastra node:dns).
 */

export interface EditorApp {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  status: 'draft' | 'published';
  homeScreen: string | null;
}

export interface EditorScreen {
  id: string;
  /** La pantalla de inicio de la app se guarda por slug, no por id. */
  slug: string;
  title: string;
  icon: string;
  roles: string[];
  viewName: string;
}

export interface EditorRole {
  key: string;
  name: string;
  description: string;
  permissions: AppPermissions;
}

export interface EditorMember {
  userId: string;
  name: string;
  email: string;
  roleKey: string;
  attributes: Record<string, string>;
}

export interface EditorAppUser {
  id: string;
  name: string;
  email: string;
  roleKey: string;
  attributes: Record<string, string>;
  status: 'invited' | 'active' | 'disabled';
  lastSeenAt: string | null;
}

export interface EditorPerson {
  id: string;
  name: string;
  email: string;
}

export interface EditorTracker {
  slug: string;
  name: string;
  fields: Array<{ key: string; label: string; type: string; options?: string[] }>;
  /** Los botones de fila que las pantallas declaran sobre esta tabla. */
  actions: Array<{ id: string; label: string }>;
}

export interface AppEditorData {
  app: EditorApp;
  screens: EditorScreen[];
  roles: EditorRole[];
  members: EditorMember[];
  /** Usuarios externos (sin cuenta de Cortex), 0209. */
  appUsers: EditorAppUser[];
  /** El enlace de entrada /a/<id>, para copiarlo. */
  entryPath: string;
  directory: EditorPerson[];
  trackers: EditorTracker[];
  /** Tablas que una pantalla lee pero que no son tablas propias (sin campos que listar). */
  unknownTrackers: string[];
}

export const SCREEN_ICONS: Array<{ name: string; label: string; icon: LucideIcon }> = [
  { name: 'ClipboardPlus', label: 'Registrar', icon: ClipboardPlus },
  { name: 'ListChecks', label: 'Lista', icon: ListChecks },
  { name: 'BadgeCheck', label: 'Aprobar', icon: BadgeCheck },
  { name: 'BarChart3', label: 'Tablero', icon: BarChart3 },
  { name: 'Table2', label: 'Tabla', icon: Table2 },
  { name: 'Camera', label: 'Cámara', icon: Camera },
  { name: 'Truck', label: 'Camión', icon: Truck },
  { name: 'Users', label: 'Personas', icon: Users },
  { name: 'Home', label: 'Inicio', icon: Home },
  { name: 'Calendar', label: 'Calendario', icon: Calendar },
  { name: 'Package', label: 'Paquete', icon: Package },
];

export function ScreenIcon({ name, className }: { name: string; className?: string }) {
  const Icon = SCREEN_ICONS.find((i) => i.name === name)?.icon ?? LayoutPanelTop;
  return <Icon className={className} aria-hidden />;
}

export const BTN_PRIMARY =
  'cortex-primary-button inline-flex h-8 items-center justify-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white shadow-card transition-all duration-150 hover:bg-primary-strong disabled:opacity-50';
export const BTN_SECONDARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40';
export const BTN_DANGER =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-pill border border-rose/30 bg-surface px-3 text-xs font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-40';
export const INPUT =
  'h-8 rounded-pill border border-border bg-surface px-3 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary';
export const CARD = 'rounded-card border border-border bg-surface p-4 shadow-card';

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-card bg-rose-soft px-3 py-2 text-xs text-rose">
      {error}
    </p>
  );
}

/** «Planta Norte» → «planta_norte»: a-z0-9_, empieza en letra, ≤32. */
export function roleKeyOf(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return /^[a-z]/.test(base) ? base : `r_${base}`.slice(0, 32);
}
