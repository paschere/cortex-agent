/**
 * Los últimos errores del navegador, para adjuntarlos a un mensaje a soporte.
 *
 * Se guardan en `sessionStorage` (la pestaña, no el equipo) y sólo el mensaje
 * recortado: nunca la pila entera ni datos de la página. Se instala una vez,
 * desde el botón «?» que está en toda pantalla.
 */

const KEY = 'cortex:recent-errors';
const MAX = 5;
let installed = false;

function read(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function push(message: string): void {
  try {
    const at = new Date().toISOString().slice(11, 19);
    const entry = `${at} ${window.location.pathname}: ${message}`.slice(0, 300);
    const next = [...read(), entry].slice(-MAX);
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento (modo privado, bloqueado): no hay errores que adjuntar.
  }
}

export function installRecentErrors(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    push(event.message || 'Error sin mensaje');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    push(reason instanceof Error ? reason.message : String(reason ?? 'Promesa rechazada'));
  });
}

export function recentErrors(): string[] {
  if (typeof window === 'undefined') return [];
  return read();
}
