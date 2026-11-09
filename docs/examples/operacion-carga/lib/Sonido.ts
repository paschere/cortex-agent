/**
 * Pitido corto con WebAudio (sin archivos) y vibración para las críticas nuevas.
 * El navegador solo deja sonar tras un toque de la persona: por eso `prepararSonido()` se llama
 * en el primer toque/tecla y al encender el sonido.
 */
let ctx: AudioContext | null = null;

function contexto(): AudioContext | null {
  try {
    if (!ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    return ctx;
  } catch {
    return null;
  }
}

export function prepararSonido(): void {
  const c = contexto();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
}

/** Dos tonos (alerta de crítica) o uno corto (aviso normal). */
export function pitar(critico: boolean): void {
  const c = contexto();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  const t0 = c.currentTime + 0.01;
  const tonos = critico ? [880, 660, 880] : [740];
  tonos.forEach((hz, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = hz;
    const ini = t0 + i * 0.16;
    g.gain.setValueAtTime(0.0001, ini);
    g.gain.exponentialRampToValueAtTime(0.22, ini + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ini + 0.14);
    o.connect(g);
    g.connect(c.destination);
    o.start(ini);
    o.stop(ini + 0.16);
  });
}

export function vibrar(critico: boolean): void {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // el navegador solo deja vibrar tras un toque
    navigator.vibrate?.(critico ? [220, 90, 220, 90, 320] : [80]);
  } catch {
    /* sin vibración */
  }
}
