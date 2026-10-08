import { clsx } from 'clsx';
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
 * Los íconos que el agente guarda son nombres de lucide de una lista corta;
 * cualquier otra cosa se pinta como emoji. Compartido por el marco de la app y
 * el Inicio.
 */
export const APP_ICONS: Record<string, LucideIcon> = {
  ClipboardPlus,
  ListChecks,
  BadgeCheck,
  BarChart3,
  Table2,
  Camera,
  Truck,
  Users,
  Home,
  Calendar,
  Package,
  LayoutPanelTop,
};

export function Glyph({ name, className }: { name: string; className?: string }) {
  const Icon = APP_ICONS[name];
  if (Icon) return <Icon className={className} aria-hidden />;
  return (
    <span className={clsx('inline-grid place-items-center leading-none', className)} aria-hidden>
      {name || '▫️'}
    </span>
  );
}
