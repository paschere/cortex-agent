'use client';

import { PANEL_MESSAGE } from '@/lib/chat-app-panel';
import { useEffect, useRef } from 'react';

/**
 * Lo que hace falta dentro del iframe del panel:
 *  - el tema que pidió el panel (`?tema=dark|light`),
 *  - que cualquier enlace que salga del panel (el editor de una pantalla, «Abrir
 *    la app») se abra en otra pestaña en vez de meter el espacio de trabajo
 *    completo dentro del iframe.
 */
export function EmbedChrome() {
  useEffect(() => {
    const apply = () => {
      const tema = new URLSearchParams(window.location.search).get('tema');
      if (tema === 'dark' || tema === 'light') document.documentElement.dataset.theme = tema;
    };
    apply();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('/') || href.startsWith('/panel/')) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return null;
}

/** El editor le avisa al panel cuando lo guardado cambió (cada `router.refresh()` trae otro sello). */
export function EmbedBridge({ appId, stamp }: { appId: string; stamp: string }) {
  const last = useRef(stamp);
  useEffect(() => {
    if (last.current === stamp) return;
    last.current = stamp;
    window.parent?.postMessage(
      { type: PANEL_MESSAGE, event: 'edited', appId, stamp },
      window.location.origin,
    );
  }, [appId, stamp]);
  return null;
}
