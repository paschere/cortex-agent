'use client';

import { useEffect } from 'react';

export function useGlobalHotkeys(handlers: Record<string, () => void>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') {
        e.preventDefault();
        handlers['mod+k']?.();
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        handlers['mod+/']?.();
      }
      if (e.key === 'Escape') handlers['escape']?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
