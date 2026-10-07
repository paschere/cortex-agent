'use client';

import {
  type ServerTurn,
  type VoiceCommand,
  type VoiceCtx,
  type VoiceDef,
  type VoiceOutcome,
  type VoicePhase,
  type VoiceState,
  answer,
  applyLocation,
  applyServerTurn,
  canConverse,
  giveUp,
  repeatPrompt,
  startVoice,
} from '@/lib/views/voice-form';
import { formatLocation } from '@cortex/agent-tools/src/trackers/schema';
import { nowBogota, todayBogota } from '@cortex/agent-tools/src/trackers/validation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canRecord, recognitionCtor } from './DictateRecord';
import type { FormController } from './blocks/form-voice-bridge';
import {
  type Job,
  type ListenJob,
  canSpeak,
  listenRecord,
  listenSpeech,
  speakBrowser,
  speakCortex,
} from './voice-io';

/**
 * LA CONVERSACIÓN, ORQUESTADA. Junta el motor puro (lib/views/voice-form.ts),
 * la voz y el oído (voice-io.ts) y el formulario (FormController). El ciclo:
 *
 *   hablar → escuchar → (motor | servidor) → poner valores en el formulario →
 *   hablar…  hasta que se confirma y se envía por el camino del formulario.
 *
 * Reglas que esto garantiza:
 *   - NUNCA se escucha a sí mismo: no se abre el micrófono mientras habla.
 *   - TOCAR interrumpe: mientras habla, salta a escuchar; mientras escucha,
 *     entrega lo que ya oyó.
 *   - Cada paso comprueba que su conversación siga viva (`run`): cerrar o
 *     reiniciar corta cualquier cosa en vuelo.
 *   - Sin señal o sin servidor, lo simple sigue funcionando (el motor no usa red).
 */

export type UiPhase = 'idle' | 'tap' | 'speaking' | 'listening' | 'thinking' | 'ended';

interface Settings {
  rate: number;
  cortex: boolean;
}

const KEY = 'cortex-voice-form';
const DEFAULTS: Settings = { rate: 1, cortex: false };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    const rate = Number(raw?.rate);
    return {
      rate: Number.isFinite(rate) && rate >= 0.7 && rate <= 1.4 ? rate : DEFAULTS.rate,
      cortex: raw?.cortex === true,
    };
  } catch {
    return DEFAULTS;
  }
}

const ctxNow = (): VoiceCtx => ({ today: todayBogota(), now: nowBogota() });

function turnEndpoint(c: FormController): string | null {
  if (c.target.kind === 'app') return `/api/views/${c.target.viewId}/voice-turn`;
  if (c.target.kind === 'public') return '/api/views/public/voice-turn';
  if (c.target.kind === 'custom_app')
    return `/api/apps/${c.target.appId}/screens/${c.target.screen}/voice-turn`;
  return null;
}

/** Lo que viaja como contexto: sin archivos ni textos enormes. */
function slimValues(c: FormController, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(
    c.fields.filter((f) => f.type === 'file' || f.type === 'relation').map((f) => f.key),
  );
  for (const [k, v] of Object.entries(values)) if (!skip.has(k) && v && v.length <= 400) out[k] = v;
  return out;
}

export function useVoiceForm(controller: FormController | undefined) {
  const [phase, setPhase] = useState<UiPhase>('idle');
  const [said, setSaid] = useState('');
  const [heard, setHeard] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [engine, setEngine] = useState<VoicePhase | null>(null);
  const [settings, setSettingsState] = useState<Settings>(DEFAULTS);
  const [cortexAvailable, setCortexAvailable] = useState(false);

  const ctrl = useRef(controller);
  ctrl.current = controller;
  const run = useRef(0);
  const eng = useRef<VoiceState | null>(null);
  const speaking = useRef<Job<boolean> | null>(null);
  const listening = useRef<ListenJob | null>(null);
  const aborts = useRef(new Set<AbortController>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const cortexRef = useRef(false);
  cortexRef.current = cortexAvailable;
  const inputMode = useRef<'speech' | 'record' | null>(null);
  /** Enviando y diciendo «Enviado»: el «listo» del formulario no debe cortar esa frase. */
  const finishing = useRef(false);

  useEffect(() => {
    setSettingsState(loadSettings());
    inputMode.current = recognitionCtor() ? 'speech' : canRecord() ? 'record' : null;
  }, []);

  const targetKind = controller?.target.kind;
  useEffect(() => {
    if (targetKind !== 'app') return;
    let live = true;
    fetch('/api/voice/speak')
      .then((r) => r.json())
      .then((b: { available?: boolean }) => live && setCortexAvailable(b.available === true))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [targetKind]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const supported =
    typeof window !== 'undefined' && (recognitionCtor() !== null || canRecord()) && canSpeak();

  const cutAll = useCallback(() => {
    run.current += 1;
    speaking.current?.cancel();
    listening.current?.cancel();
    speaking.current = null;
    listening.current = null;
    for (const a of aborts.current) a.abort();
    aborts.current.clear();
    if (canSpeak()) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => cutAll, [cutAll]);

  // El formulario mostró su «listo» (por la voz o por el dedo): la conversación terminó.
  const done = controller?.done ?? false;
  useEffect(() => {
    if (done && !finishing.current && phase !== 'idle' && phase !== 'ended') {
      cutAll();
      setPhase('ended');
    }
  }, [done, phase, cutAll]);

  const alive = (id: number) => id === run.current;

  // ---------------------------------------------------------------- hablar
  async function say(text: string, id: number) {
    if (!text) return;
    setSaid(text);
    setPhase('speaking');
    let ok = false;
    if (settingsRef.current.cortex && cortexRef.current) {
      const job = speakCortex(text);
      speaking.current = job;
      ok = await job.done;
      if (!alive(id)) return;
      if (!ok) {
        setProblem('La voz de Cortex no respondió; uso la del navegador.');
        setSettings({ cortex: false });
      }
    }
    if (!ok) {
      const job = speakBrowser(text, settingsRef.current.rate);
      speaking.current = job;
      await job.done;
    }
    if (alive(id)) speaking.current = null;
  }

  // -------------------------------------------------------------- escuchar
  async function hear(
    id: number,
  ): Promise<{ kind: 'text'; text: string } | { kind: 'silence' } | { kind: 'stop' }> {
    setPhase('listening');
    setHeard('');
    const Ctor = recognitionCtor();
    if (inputMode.current === 'speech' && Ctor) {
      const job = listenSpeech(Ctor, (t) => alive(id) && setHeard(t));
      listening.current = job;
      const res = await job.done;
      if (!alive(id)) return { kind: 'stop' };
      listening.current = null;
      if (res.error === 'not-allowed' || res.error === 'service-not-allowed') {
        setProblem(
          'El navegador no dio permiso para el micrófono. Actívalo en el candado de la barra de direcciones.',
        );
        return { kind: 'stop' };
      }
      if (res.error && res.error !== 'start-failed' && !res.text) {
        // El reconocimiento del navegador falló (red): se graba el audio.
        if (canRecord()) {
          inputMode.current = 'record';
          return hear(id);
        }
        setProblem('No pude escuchar. Revisa el micrófono o llena con el dedo.');
        return { kind: 'stop' };
      }
      return res.text ? { kind: 'text', text: res.text } : { kind: 'silence' };
    }
    if (canRecord()) {
      const job = listenRecord();
      listening.current = job;
      const blob = await job.blob.catch(() => 'denied' as const);
      if (!alive(id)) return { kind: 'stop' };
      listening.current = null;
      if (blob === 'denied') {
        setProblem('El navegador no dio permiso para el micrófono.');
        return { kind: 'stop' };
      }
      if (!blob) return { kind: 'silence' };
      setPhase('thinking');
      const text = await transcribe(blob, id);
      if (!alive(id)) return { kind: 'stop' };
      return text ? { kind: 'text', text } : { kind: 'silence' };
    }
    setProblem('Este navegador no deja usar el micrófono.');
    return { kind: 'stop' };
  }

  async function post(
    form: FormData,
    id: number,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
    const c = ctrl.current;
    const url = c ? turnEndpoint(c) : null;
    if (!c || !url) return { ok: false, status: 0, body: null };
    form.set('blockId', c.blockId);
    if (c.target.kind === 'public') form.set('token', c.target.token);
    const abort = new AbortController();
    aborts.current.add(abort);
    const timer = setTimeout(() => abort.abort(), 25000);
    try {
      const res = await fetch(url, { method: 'POST', body: form, signal: abort.signal });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { ok: res.ok, status: res.status, body };
    } catch {
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timer);
      aborts.current.delete(abort);
      void id;
    }
  }

  async function transcribe(blob: Blob, id: number): Promise<string> {
    const form = new FormData();
    form.set('audio', blob, 'turno.webm');
    form.set('transcribeOnly', '1');
    const res = await post(form, id);
    if (!res.ok) {
      setProblem(
        typeof res.body?.error === 'string'
          ? res.body.error
          : 'No pude transcribir. Intenta otra vez.',
      );
      return '';
    }
    return typeof res.body?.heard === 'string' ? res.body.heard : '';
  }

  // ------------------------------------------------------------- servidor
  async function serverTurn(
    text: string,
    state: VoiceState,
    id: number,
  ): Promise<{ turn: ServerTurn } | { why: string }> {
    const c = ctrl.current;
    if (!c || !turnEndpoint(c)) return { why: 'No pude entender eso.' };
    if (!c.online) return { why: 'Sin señal no puedo leer frases largas; dime un dato a la vez.' };
    const form = new FormData();
    form.set('text', text);
    if (state.current) form.set('current', state.current);
    form.set('values', JSON.stringify(slimValues(c, state.values)));
    const res = await post(form, id);
    if (!res.ok) {
      const msg = typeof res.body?.error === 'string' ? res.body.error : '';
      return { why: msg || 'No pude procesar eso ahora; dime un dato a la vez.' };
    }
    const b = res.body ?? {};
    return {
      turn: {
        values: (b.values as Record<string, string>) ?? {},
        command: (b.command as VoiceCommand | null) ?? null,
        commandField: (b.commandField as string | null) ?? null,
      },
    };
  }

  const defOf = (c: FormController): VoiceDef => ({
    fields: c.fields,
    steps: c.steps,
    prepare: c.prepare,
  });

  async function process(text: string, id: number): Promise<VoiceOutcome | null> {
    const c = ctrl.current;
    const base = eng.current;
    if (!c || !base) return null;
    setHeard(text);
    setPhase('thinking');
    const def = defOf(c);
    // El formulario manda: lo que la persona tocó con el dedo cuenta.
    const cur: VoiceState = { ...base, values: { ...base.values, ...c.values } };
    const ctx = ctxNow();
    let out = answer(def, cur, text, ctx);
    if (out.server) {
      const res = await serverTurn(text, cur, id);
      if (!alive(id)) return null;
      out =
        'turn' in res ? applyServerTurn(def, cur, res.turn, ctx) : giveUp(def, cur, ctx, res.why);
    }
    return out;
  }

  // -------------------------------------------------------------- efectos
  function whereAmI(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(formatLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })),
        () => resolve(null),
        { timeout: 10000, maximumAge: 60000 },
      );
    });
  }

  async function runEffect(out: VoiceOutcome, id: number): Promise<VoiceOutcome | 'end' | null> {
    const c = ctrl.current;
    const effect = out.effect;
    if (!c || !effect) return null;
    if (effect.type === 'cancel') return 'end';
    if (effect.type === 'geolocate') {
      setPhase('thinking');
      const where = await whereAmI();
      if (!alive(id) || !eng.current) return 'end';
      return applyLocation(defOf(c), eng.current, effect.key, where, ctxNow());
    }
    // submit
    setPhase('thinking');
    finishing.current = true;
    const res = await c.submit();
    if (!alive(id)) {
      finishing.current = false;
      return 'end';
    }
    if (res.ok) {
      const tail = res.offline
        ? 'Sin señal: lo guardé en el teléfono y se envía solo cuando vuelva.'
        : `Enviado.${res.duplicate ? ` Ojo: ${res.duplicate}` : ' Gracias.'}`;
      await say(tail, id);
      finishing.current = false;
      return 'end';
    }
    finishing.current = false;
    if (!eng.current) return 'end';
    return {
      state: { ...eng.current, phase: 'confirming', awaitingFix: false },
      say: `No se pudo enviar: ${res.error} Di enviar para intentarlo otra vez, o corrige algo.`,
    };
  }

  // ------------------------------------------------------------- el ciclo
  function commit(out: VoiceOutcome) {
    const c = ctrl.current;
    const before = eng.current?.values ?? {};
    eng.current = out.state;
    setEngine(out.state.phase);
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.state.values)) if (before[k] !== v) patch[k] = v;
    if (c && Object.keys(patch).length) c.setValues(patch);
  }

  async function converse(first: VoiceOutcome | null, id: number) {
    let out = first;
    let silences = 0;
    while (out && alive(id)) {
      commit(out);
      if (out.say) await say(out.say, id);
      if (!alive(id)) return;
      if (out.effect) {
        const next = await runEffect(out, id);
        if (!alive(id)) return;
        if (next === 'end') {
          setPhase('ended');
          return;
        }
        if (next) {
          out = next;
          continue;
        }
      }
      if (out.state.phase === 'done') {
        setPhase('ended');
        return;
      }
      // Dejar que el formulario se repinte con lo nuevo antes de oír.
      await new Promise((r) => setTimeout(r, 60));
      if (!alive(id)) return;
      const got = await hear(id);
      if (!alive(id) || got.kind === 'stop') {
        if (alive(id)) setPhase('idle');
        return;
      }
      if (got.kind === 'silence') {
        silences += 1;
        const state = eng.current;
        const c = ctrl.current;
        if (!state || !c) return;
        if (silences >= 3) {
          setSaid('Quedé en pausa. Toca para seguir.');
          setPhase('idle');
          return;
        }
        const again = repeatPrompt(defOf(c), state, ctxNow());
        out = { state, say: silences === 1 ? `¿Sigues ahí? ${again}` : again };
        continue;
      }
      silences = 0;
      out = await process(got.text, id);
    }
  }

  // ------------------------------------------------------------ lo público
  // Las acciones se rehacen en cada render (usan el estado vivo por refs) y se
  // exponen por unas envolturas estables, para que quien las usa en un efecto
  // no se reinicie en cada cambio.
  const api = useRef({
    start: () => {},
    resume: () => {},
    tap: () => {},
    inject: (_text: string) => {},
    startOrAsk: () => {},
  });

  const start = () => {
    const c = ctrl.current;
    if (!c || c.disabled) return;
    cutAll();
    const id = run.current;
    setProblem(null);
    setSaid('');
    setHeard('');
    const def = defOf(c);
    if (!canConverse(def)) {
      setProblem('Este formulario sólo tiene campos para llenar en la pantalla.');
      return;
    }
    const out = startVoice(def, c.values, ctxNow());
    eng.current = out.state;
    void converse(out, id);
  };

  const resume = () => {
    const c = ctrl.current;
    const state = eng.current;
    if (!c || !state) return start();
    cutAll();
    const id = run.current;
    setProblem(null);
    void converse({ state, say: repeatPrompt(defOf(c), state, ctxNow()) }, id);
  };

  api.current = {
    start,
    resume,
    // Tocar el indicador: interrumpe al hablar, entrega lo oído al escuchar, o arranca.
    tap: () => {
      if (phase === 'speaking') return speaking.current?.cancel();
      if (phase === 'listening') return listening.current?.stop();
      if (phase === 'thinking') return;
      if (phase === 'idle' && eng.current && eng.current.phase !== 'done') return resume();
      start();
    },
    // Lo mismo que decirlo, con el dedo («Repetir», «Saltar», «Sí, enviar»…).
    inject: (text: string) => {
      if (!eng.current || phase === 'ended') return;
      cutAll();
      const id = run.current;
      void (async () => {
        const out = await process(text, id);
        if (alive(id)) void converse(out, id);
      })();
    },
    // La pantalla abrió sin gesto del usuario: la voz del navegador puede estar bloqueada.
    startOrAsk: () => {
      const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
        .userActivation?.hasBeenActive;
      if (active === false) setPhase('tap');
      else start();
    },
  };

  const stable = useMemo(
    () => ({
      start: () => api.current.start(),
      tap: () => api.current.tap(),
      inject: (text: string) => api.current.inject(text),
      startOrAsk: () => api.current.startOrAsk(),
      stop: () => {
        cutAll();
        eng.current = null;
        setEngine(null);
        setPhase('idle');
        setSaid('');
        setHeard('');
      },
    }),
    [cutAll],
  );

  return {
    supported,
    phase,
    said,
    heard,
    problem,
    engine,
    settings,
    setSettings,
    cortexAvailable,
    ...stable,
  };
}
