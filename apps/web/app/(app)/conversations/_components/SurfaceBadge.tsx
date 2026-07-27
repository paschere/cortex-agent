import { type ConversationSurface, SURFACE_META } from '@/lib/conversation-surface';
import { clsx } from 'clsx';

/** Icon + label pill telling a Claude session apart from a Google Chat thread. */
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
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-pill font-semibold',
        meta.chip,
        size === 'sm' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]',
      )}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {meta.label}
    </span>
  );
}
