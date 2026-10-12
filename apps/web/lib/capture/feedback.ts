'use client';

import { type FeedbackKind, feedbackPlan } from './scan';

/**
 * El pitido y la vibración de cada lectura. Se oye distinto lo bueno (un tono
 * agudo corto), lo repetido (dos tonos bajos) y lo que falló (uno grave): en una
 * bodega con ruido, la persona sabe sin mirar la pantalla. Todo en try/catch:
 * un navegador sin audio o sin vibración (iPhone no vibra) sigue funcionando.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function playFeedback(kind: FeedbackKind): void {
  const plan = feedbackPlan(kind);
  try {
    navigator.vibrate?.(plan.vibrate);
  } catch {}
  const c = audio();
  if (!c) return;
  try {
    let at = c.currentTime;
    for (const tone of plan.tones) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      osc.frequency.value = tone.hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.ms / 1000);
      osc.connect(gain).connect(c.destination);
      osc.start(at);
      osc.stop(at + tone.ms / 1000 + 0.02);
      at += tone.ms / 1000 + 0.04;
    }
  } catch {}
}
