import { type Recognition, type RecognitionCtor, canRecord } from './DictateRecord';

/**
 * LO QUE TOCA EL NAVEGADOR EN EL ASISTENTE DE VOZ: hablar (la voz del
 * navegador o la de Cortex) y escuchar (SpeechRecognition o grabar y mandar el
 * audio). Cada función devuelve un `Job`: una promesa y la forma de cortarla,
 * porque tocar la pantalla interrumpe y nunca se escucha mientras se habla.
 * La conversación vive en lib/views/voice-form.ts y se orquesta en
 * useVoiceForm.ts.
 */

export interface Job<T> {
  done: Promise<T>;
  cancel: () => void;
}

export interface ListenJob extends Job<ListenResult> {
  /** Deja de escuchar pero entrega lo que ya se oyó. */
  stop: () => void;
}

export interface ListenResult {
  text: string;
  error: string | null;
}

/** Frases de a lo sumo `max` letras: las voces del navegador se atragantan con textos largos. */
export function splitSentences(text: string, max: number): string[] {
  const parts = text.match(/[^.!?¿¡:]+[.!?:]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    const last = out[out.length - 1];
    if (last && last.length + s.length + 1 <= max) out[out.length - 1] = `${last} ${s}`;
    else out.push(s.slice(0, max));
  }
  return out;
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** La mejor voz en español: es-CO, luego es-419, es-MX, es-US, cualquier es. */
export function pickVoice(): SpeechSynthesisVoice | null {
  if (!canSpeak()) return null;
  const voices = window.speechSynthesis.getVoices();
  const lang = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase();
  for (const want of ['es-co', 'es-419', 'es-mx', 'es-us']) {
    const hit = voices.find((v) => lang(v) === want);
    if (hit) return hit;
  }
  return voices.find((v) => lang(v).startsWith('es')) ?? null;
}

const never = (): Job<boolean> => ({ done: Promise.resolve(false), cancel: () => {} });

/** Habla con la voz del navegador. Resuelve false si el navegador no la dejó sonar. */
export function speakBrowser(text: string, rate: number): Job<boolean> {
  if (!canSpeak()) return never();
  const synth = window.speechSynthesis;
  let cancelled = false;
  let finish: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const chunks = splitSentences(text, 220);
  const voice = pickVoice();
  let i = 0;
  let started = false;
  const guard = setTimeout(() => finish(true), Math.max(8000, text.length * 110));
  const blocked = setTimeout(() => {
    if (!started && !cancelled) {
      synth.cancel();
      finish(false);
    }
  }, 3500);
  const next = () => {
    if (cancelled || i >= chunks.length) {
      clearTimeout(guard);
      clearTimeout(blocked);
      return finish(true);
    }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.lang = voice?.lang ?? 'es-CO';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onstart = () => {
      started = true;
    };
    u.onend = next;
    u.onerror = (e) => {
      clearTimeout(guard);
      clearTimeout(blocked);
      finish(cancelled || e.error === 'interrupted' || e.error === 'canceled');
    };
    synth.speak(u);
  };
  synth.cancel();
  next();
  return {
    done,
    cancel: () => {
      cancelled = true;
      clearTimeout(guard);
      clearTimeout(blocked);
      synth.cancel();
      finish(true);
    },
  };
}

/** Habla con la voz de Cortex (/api/voice/speak). Resuelve false si no está disponible. */
export function speakCortex(text: string): Job<boolean> {
  const abort = new AbortController();
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  const cleanup = () => {
    audio?.pause();
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const done = (async () => {
    for (const chunk of splitSentences(text, 360)) {
      if (abort.signal.aborted) return true;
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: chunk }),
        signal: abort.signal,
      }).catch(() => null);
      if (abort.signal.aborted) return true;
      if (!res?.ok) return false;
      const blob = await res.blob().catch(() => null);
      if (!blob || abort.signal.aborted) return abort.signal.aborted;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      const played = await new Promise<boolean>((resolve) => {
        if (!audio) return resolve(false);
        audio.onended = () => resolve(true);
        audio.onerror = () => resolve(false);
        audio.play().catch(() => resolve(false));
        abort.signal.addEventListener('abort', () => resolve(true), { once: true });
      });
      cleanup();
      if (!played) return false;
    }
    return true;
  })().catch(() => false);
  return {
    done,
    cancel: () => {
      abort.abort();
      cleanup();
    },
  };
}

/** Escucha UNA frase con el reconocimiento del navegador (es-CO). */
export function listenSpeech(Ctor: RecognitionCtor, onInterim: (text: string) => void): ListenJob {
  const r: Recognition = new Ctor();
  r.lang = 'es-CO';
  r.continuous = false;
  r.interimResults = true;
  let text = '';
  let interim = '';
  let error: string | null = null;
  let finish: (v: ListenResult) => void = () => {};
  let cancelled = false;
  const done = new Promise<ListenResult>((resolve) => {
    finish = resolve;
  });
  // Nadie dijo nada: se corta para no quedar escuchando al aire.
  const silence = setTimeout(() => r.stop(), 9000);
  r.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const res = e.results[i];
      if (!res) continue;
      if (res.isFinal) text += ` ${res[0].transcript}`;
      else interim += res[0].transcript;
    }
    onInterim(`${text} ${interim}`.trim());
  };
  r.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') error = e.error;
  };
  r.onend = () => {
    clearTimeout(silence);
    finish({ text: cancelled ? '' : `${text} ${interim}`.trim(), error });
  };
  try {
    r.start();
  } catch {
    clearTimeout(silence);
    finish({ text: '', error: 'start-failed' });
  }
  return {
    done,
    stop: () => {
      try {
        r.stop();
      } catch {}
    },
    cancel: () => {
      cancelled = true;
      try {
        r.abort();
      } catch {}
    },
  };
}

/**
 * Graba una frase (Firefox y quien no tiene reconocimiento): empieza al oír
 * voz, termina tras un silencio de ~1,3 s. Devuelve null si nadie habló.
 */
export function listenRecord(): ListenJob & { blob: Promise<Blob | null> } {
  let cancelled = false;
  let stopNow = () => {};
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  const blob = (async (): Promise<Blob | null> => {
    if (!canRecord()) return null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      throw new Error('not-allowed');
    }
    if (cancelled) return null;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    return new Promise<Blob | null>((resolve) => {
      let spoke = false;
      let lastVoice = 0;
      const t0 = Date.now();
      const end = (keep: boolean) => {
        clearInterval(tick);
        rec.onstop = () => {
          for (const t of stream?.getTracks() ?? []) t.stop();
          void ctx?.close().catch(() => {});
          resolve(
            keep && spoke && chunks.length
              ? new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] })
              : null,
          );
        };
        if (rec.state !== 'inactive') rec.stop();
        else rec.onstop?.(new Event('stop'));
      };
      stopNow = () => end(true);
      const tick = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((s, v) => s + ((v - 128) / 128) ** 2, 0) / samples.length,
        );
        const now = Date.now();
        if (rms > 0.04) {
          spoke = true;
          lastVoice = now;
        }
        if (cancelled) end(false);
        else if (spoke && now - lastVoice > 1300) end(true);
        else if (now - t0 > (spoke ? 20000 : 9000)) end(spoke);
      }, 100);
      rec.start();
    });
  })();
  return {
    blob,
    done: blob.then(
      () => ({ text: '', error: null }),
      (e: Error) => ({ text: '', error: e.message }),
    ),
    stop: () => stopNow(),
    cancel: () => {
      cancelled = true;
      stopNow();
      for (const t of stream?.getTracks() ?? []) t.stop();
    },
  };
}
