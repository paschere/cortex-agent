'use client';

/**
 * LAS SEÑALES DE «LLEGÓ ALGO»: el pitido, la notificación del sistema y el
 * titileo de una fila. Las comparten las vistas (LiveViewCanvas) y Tablas,
 * para que un registro nuevo suene y se vea igual en las dos.
 *
 * El pitido es Web Audio (dos tonos cortos), no un archivo: no hay nada que
 * descargar y el navegador lo deja sonar sólo después de un gesto de la
 * persona — por eso `unlockAudio` se llama en el clic que activa los avisos.
 */

let shared: AudioContext | null = null;

/** Crea (o despierta) el contexto de audio. Llamar dentro de un clic. */
export function unlockAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    shared ??= new AudioContext();
    if (shared.state === 'suspended') void shared.resume();
    return shared;
  } catch {
    return null;
  }
}

export function beep(ctx: AudioContext | null = shared) {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1318].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.14);
    gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.14 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.14);
    osc.stop(now + i * 0.14 + 0.25);
  }
}

/** Notificación del sistema, sólo si ya hay permiso y la pestaña no está a la vista. */
export function desktopNotify(title: string, body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, tag: 'cortex-live' });
  } catch {
    // Safari en iOS sin PWA: no hay notificaciones; el toast en pantalla basta.
  }
}

/**
 * Clase CSS que hace titilar una fila o tarjeta recién llegada (definida en
 * globals.css como `.live-flash`). Dura unos segundos y se apaga sola.
 */
export const LIVE_FLASH_CLASS = 'live-flash';
export const LIVE_FLASH_MS = 6000;
