import type { SiteRule } from '../../../packages/agent-tools/src/browser/chrome/consent';

/**
 * Estado y mensajes compartidos entre el service worker, el panel lateral, la
 * ventana de consentimiento y el script de la página.
 *
 * DÓNDE VIVE CADA COSA
 *   storage.local    el token del dispositivo, el origen de Cortex y las reglas
 *                    por sitio. Solo la extensión puede leerlo (una página web
 *                    no tiene acceso a esta área).
 *   storage.session  las sesiones de trabajo y el registro de pasos: se
 *                    borran al cerrar el navegador, como deben.
 */

export const VERSION = '0.1.0';
declare const __CORTEX_ORIGIN__: string | undefined;
/** El Cortex al que apunta esta compilación (CORTEX_ORIGIN al construir). */
export const DEFAULT_ORIGIN: string =
  typeof __CORTEX_ORIGIN__ === 'string' ? __CORTEX_ORIGIN__ : 'https://cortex-vertix.vercel.app';
/** Tope local de acciones por sesión (el servidor manda el suyo; vale el menor). */
export const LOCAL_CAP = 150;

export interface LocalRule extends SiteRule {
  /** El servidor ya conoce la regla. Solo las sincronizadas se borran por revocación remota. */
  synced: boolean;
}

export interface Stored {
  origin: string;
  token: string;
  deviceName: string;
  rules: LocalRule[];
}

export interface SessionState {
  id: string;
  tabId: number | null;
  windowId: number | null;
  purpose: string;
  /** Sitios concedidos «solo esta vez» a esta sesión. */
  onceSites: string[];
  /** Patrones de permiso de Chrome concedidos «solo esta vez» (se retiran al terminar). */
  onceOrigins: string[];
  actions: number;
  cap: number;
  stopped: boolean;
  closed: boolean;
  awaiting: { kind: 'help' | 'secret'; text: string } | null;
  startedAt: number;
}

export interface StepLog {
  at: number;
  sessionId: string;
  text: string;
  ok: boolean;
}

export const DEFAULT_PROTECTED: string[] = [];

export async function getStored(): Promise<Stored | null> {
  const got = await chrome.storage.local.get('cortex');
  const v = got.cortex as Stored | undefined;
  return v?.token && v.origin ? v : null;
}
export async function setStored(v: Stored | null): Promise<void> {
  if (v) await chrome.storage.local.set({ cortex: v });
  else await chrome.storage.local.remove('cortex');
}

export async function getSessions(): Promise<Record<string, SessionState>> {
  const got = await chrome.storage.session.get('sessions');
  return (got.sessions as Record<string, SessionState> | undefined) ?? {};
}
export async function putSession(s: SessionState): Promise<void> {
  const all = await getSessions();
  all[s.id] = s;
  await chrome.storage.session.set({ sessions: all });
}

export async function getSteps(): Promise<StepLog[]> {
  const got = await chrome.storage.session.get('steps');
  return (got.steps as StepLog[] | undefined) ?? [];
}
export async function logStep(step: Omit<StepLog, 'at'>): Promise<void> {
  const steps = await getSteps();
  steps.push({ ...step, at: Date.now() });
  await chrome.storage.session.set({ steps: steps.slice(-60) });
}

/** Cortex mismo: la extensión jamás maneja la pantalla donde la persona aprueba. */
export function protectedHostsOf(origin: string): string[] {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
    return [host];
  } catch {
    return [];
  }
}

export function originPattern(site: string): string {
  return `*://*.${site}/*`;
}

/** Mensajes hacia el service worker. */
export type ToBackground =
  | { type: 'wake' }
  | { type: 'consent-result'; id: string; decision: 'once' | 'always' | 'never' | 'deny' }
  | { type: 'person-done'; sessionId: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'stop-all' }
  | { type: 'remove-rule'; site: string }
  | { type: 'unpair' };

export function sendBackground(msg: ToBackground): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

/** Mensajes hacia el script de la página. */
export type ToContent =
  | { type: 'cortex:read'; offset: number; protectedHosts: string[] }
  | {
      type: 'cortex:act';
      op: 'click' | 'fill' | 'select' | 'check' | 'press' | 'scroll';
      ref?: string;
      name?: string;
      text?: string;
      key?: string;
      dy?: number;
      protectedHosts: string[];
    }
  | { type: 'cortex:secret'; ref: string; name: string; label: string; sessionId: string }
  | { type: 'cortex:help'; reason: string; sessionId: string }
  | { type: 'cortex:banner'; sessionId: string; on: boolean; message?: string | null }
  | { type: 'cortex:clear-await' };
