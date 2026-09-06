'use client';

import { Globe } from 'lucide-react';
import Link from 'next/link';

/** A separate tab preserves the conversation and its unsent composer draft. */
export function TeachFlowLink() {
  return (
    <Link
      href="/browser#cortex-browser"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Enseñar un trámite en el navegador de Cortex (abre otra pestaña)"
      title="Enseñar en el navegador de Cortex · abre otra pestaña"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Globe className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}
