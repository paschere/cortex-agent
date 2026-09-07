import type { WorkspaceKind } from '@cortex/core';
import { Building2 } from 'lucide-react';

export function CorporateSupervisionNotice({ kind }: { kind?: WorkspaceKind }) {
  if (kind !== 'company') return null;
  return (
    <div className="mx-3 mb-3 flex gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-micro leading-relaxed text-ink-muted">
      <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
      <p>El trabajo realizado en esta empresa puede ser revisado por sus fundadores.</p>
    </div>
  );
}
