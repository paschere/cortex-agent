import { type ConversationSurface, SURFACE_META } from '@/lib/conversation-surface';
import { CHIP_BASE, CHIP_TONE } from '@/lib/status-chip';
import { clsx } from 'clsx';

/**
 * Where a conversation came from, stamped on it. Deliberately colourless: the
 * origin of a thread is not a status, and lending it green or amber would spend
 * meaning the palette needs elsewhere.
 */
export function SurfaceBadge({
  surface,
  size = 'sm',
}: {
  surface: ConversationSurface;
  size?: 'sm' | 'md';
}) {
  const meta = SURFACE_META[surface];
  const Icon = meta.icon;
  return (
    <span
      title={meta.description}
      className={clsx(CHIP_BASE, CHIP_TONE.neutral, size === 'md' && 'px-2 py-1 text-[11px]')}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {meta.label}
    </span>
  );
}
