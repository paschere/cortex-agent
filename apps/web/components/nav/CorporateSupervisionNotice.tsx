import type { WorkspaceKind } from '@cortex/core';
import { Building2 } from 'lucide-react';

export function CorporateSupervisionNotice({ kind }: { kind?: WorkspaceKind }) {
  if (kind !== 'company') return null;
  return (
    <div className="flex gap-2 rounded-sm bg-surface-2 px-3 py-2.5 text-micro leading-relaxed text-ink-muted">
      <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
      <p>El trabajo realizado en esta empresa puede ser revisado por sus fundadores.</p>
    </div>
  );
}
