'use client';

import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Flows } from './Flows';
import { Teach } from './Teach';

/**
 * The two halves of the screen, and the one piece of state they share.
 *
 * Teaching is on top because it is the thing somebody comes here to do the
 * first time, and it collapses back to a single button once it is done. The
 * library is underneath and is what the page is for on every visit after that.
 * `reloadKey` is the whole coupling: a trámite that was just saved and verified
 * appears in the list with its status already resolved, rather than needing a
 * refresh to find out whether it worked.
 */
export function Surface() {
  const [reloadKey, setReloadKey] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {saved && (
        <div className="flex items-start gap-2 rounded-card border border-emerald/20 bg-emerald-soft px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden="true" />
          <p className="text-[13px] leading-relaxed text-ink">{saved}</p>
        </div>
      )}

      <Teach
        onSaved={(message) => {
          setSaved(message);
          setReloadKey((n) => n + 1);
        }}
      />

      <Flows reloadKey={reloadKey} />
    </div>
  );
}
