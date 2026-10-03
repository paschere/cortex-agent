import type { CatalogIcon, CatalogTone } from '@/lib/sources/catalog';
import type { SourceKind, SourceTone } from '@/lib/sources/overview';
import { clsx } from 'clsx';
import {
  Braces,
  Brain,
  Building2,
  Calculator,
  Camera,
  FileSpreadsheet,
  Folder,
  FolderSync,
  GitBranch,
  Inbox,
  KeyRound,
  Landmark,
  ListTodo,
  Mail,
  MessageCircle,
  MessageSquareText,
  Server,
  Tags,
  Upload,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Lo que hace que una fuente se reconozca igual en todas partes: el mismo
 * icono y el mismo color en «Datos y conexiones», en la bandeja y en los
 * primeros pasos (/onboarding/fuentes).
 */

export type Icon = typeof Mail;

export const CATALOG_ICON: Record<CatalogIcon, Icon> = {
  google: Mail,
  outlook: Inbox,
  calculator: Calculator,
  bank: Landmark,
  folder: Folder,
  upload: Upload,
  brain: Brain,
  sheet: FileSpreadsheet,
  camera: Camera,
  whatsapp: MessageCircle,
  api: Braces,
  crm: Building2,
  chat: MessageSquareText,
  tags: Tags,
  github: GitBranch,
  linear: ListTodo,
  tools: Wrench,
  server: Server,
  key: KeyRound,
};

export const KIND_ICON: Record<SourceKind, Icon> = {
  google: Mail,
  microsoft: Inbox,
  hubspot: Building2,
  github: GitBranch,
  linear: ListTodo,
  accounting: Calculator,
  drive_folder: FolderSync,
  table_sync: FileSpreadsheet,
  feed_source: Braces,
  bank: Landmark,
  whatsapp: MessageCircle,
  inbox: Inbox,
};

export const KIND_TONE: Record<SourceKind, CatalogTone> = {
  google: 'rose',
  microsoft: 'sky',
  hubspot: 'amber',
  github: 'neutral',
  linear: 'neutral',
  accounting: 'amber',
  drive_folder: 'primary',
  table_sync: 'emerald',
  feed_source: 'primary',
  bank: 'emerald',
  whatsapp: 'emerald',
  inbox: 'neutral',
};

export const TONE_CHIP: Record<CatalogTone, string> = {
  primary: 'bg-primary-soft text-primary',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  rose: 'bg-rose-soft text-rose',
  sky: 'bg-sky-soft text-sky',
  neutral: 'bg-surface-2 text-ink-muted',
};

/** La píldora del estado: el mismo vocabulario de color que el resto del producto. */
export const STATUS_PILL: Record<SourceTone, string> = {
  ok: 'bg-emerald-soft text-emerald',
  working: 'bg-primary-soft text-primary',
  attention: 'bg-amber-soft text-amber',
  error: 'bg-rose-soft text-rose',
  paused: 'bg-surface-2 text-ink-muted',
};

export const STATUS_DOT: Record<SourceTone, string> = {
  ok: 'bg-emerald',
  working: 'bg-primary',
  attention: 'bg-amber',
  error: 'bg-rose',
  paused: 'bg-ink-faint',
};

export function IconTile({
  icon: I,
  tone,
  size = 'md',
}: {
  icon: Icon;
  tone: CatalogTone;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-sm',
        size === 'md' ? 'h-10 w-10' : 'h-8 w-8',
        TONE_CHIP[tone],
      )}
      aria-hidden
    >
      <I className={size === 'md' ? 'h-5 w-5' : 'h-4 w-4'} />
    </span>
  );
}

/** Icono + título + una frase: la tarjeta de «elige una fuente», en todas partes igual. */
export function SourceTile({
  icon,
  tone,
  title,
  body,
  badge,
}: {
  icon: Icon;
  tone: CatalogTone;
  title: string;
  body: string;
  badge?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-start gap-3.5">
      <IconTile icon={icon} tone={tone} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-extrabold text-ink">{title}</span>
          {badge}
        </span>
        <span className="text-xs leading-relaxed text-ink-muted">{body}</span>
      </span>
    </span>
  );
}
