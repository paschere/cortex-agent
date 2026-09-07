'use client';

import { workspaceHref } from '@/lib/workspace-context';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

export function OpenWorkspace({
  workspaceId,
  href,
  children,
  className,
}: { workspaceId: string; href: string; children: React.ReactNode; className?: string }) {
  const [loading, setLoading] = useState(false);
  async function open() {
    if (loading) return;
    setLoading(true);
    window.location.assign(workspaceHref(workspaceId, href));
  }
  return (
    <button type="button" onClick={open} disabled={loading} className={className}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
