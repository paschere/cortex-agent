'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether this person has asked their machine to stop moving things.
 *
 * `globals.css` already flattens every CSS transition under
 * `prefers-reduced-motion: reduce`, which covers the ink levels and the washes.
 * It cannot cover what JavaScript animates frame by frame — the graph gliding
 * to centre a document — so that code asks here and jumps straight to the end
 * state instead. Read through `useSyncExternalStore` so it is correct on the
 * server (no motion is the safe answer before hydration) and updates live if
 * the setting is changed while the page is open.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function read(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** The server has no setting to read; assume none rather than guess wrong. */
function readOnServer(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, readOnServer);
}
