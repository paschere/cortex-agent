'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  Check,
  CircleStop,
  Headphones,
  Loader2,
  LockKeyhole,
  Mic,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Sparkles,
  Upload,
  Volume2,
} from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_RECORDING_SECONDS,
  type RecordingKind,
  formatDuration,
  recordingDurationError,
  recordingSizeError,
  stopStaleStream,
} from './voice-recording';

type Profile = {
  id: string;
  name: string;
  language: string;
  active: boolean;
  createdAt: string;
};

type VoiceState = {
  profiles: Profile[];
  activeId: string | null;
  canManage: boolean;
  configured: boolean;
  consentPhrase: string;
};

type Clip = { file: File; url: string; seconds: number };
type Notice = { tone: 'error' | 'success' | 'info'; text: string };
type Access = 'unknown' | 'checking' | 'enabled' | 'blocked';

const FALLBACK_CONSENT =
  'Soy el propietario de esta voz y doy mi consentimiento para que OpenAI la utilice para crear un modelo de voz sintética.';

function apiUrl(workspaceId: string, path = '/api/settings/voice') {
  return workspaceHref(workspaceId, path);
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  return body.message ?? body.error ?? fallback;
}

async function audioDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      const timer = window.setTimeout(() => reject(new Error('timeout')), 8000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve(audio.duration);
      };
      audio.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('metadata'));
      };
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function VoiceSettings({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const [state, setState] = useState<VoiceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [access, setAccess] = useState<Access>('unknown');
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState<string | 'bossa' | null>(null);
  const [previewing, setPreviewing] = useState<string | 'bossa' | null>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState<Clip | null>(null);
  const [sample, setSample] = useState<Clip | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const createLockRef = useRef(false);
  const clipsRef = useRef<{ consent: Clip | null; sample: Clip | null }>({ consent, sample });

  const beginOperation = useCallback(() => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadVersion triggers an explicit retry of the workspace read.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    setAccess('unknown');
    void fetch(apiUrl(workspaceId), { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseMessage(res, 'No pudimos cargar las voces.'));
        return res.json() as Promise<VoiceState>;
      })
      .then(setState)
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setLoadError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, reloadVersion]);

  useEffect(() => {
    clipsRef.current = { consent, sample };
  }, [consent, sample]);

  useEffect(() => {
    return () => {
      operationRef.current?.abort();
      previewAudioRef.current?.pause();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (clipsRef.current.consent) URL.revokeObjectURL(clipsRef.current.consent.url);
      if (clipsRef.current.sample) URL.revokeObjectURL(clipsRef.current.sample.url);
    };
  }, []);

  async function checkAccess() {
    if (creating || createLockRef.current) return;
    const controller = beginOperation();
    setAccess('checking');
    setNotice(null);
    try {
      const res = await fetch(apiUrl(workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check-access' }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        access?: 'enabled' | 'blocked';
        consentPhrase?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.message ?? body.error ?? 'No pudimos comprobar el acceso.');
      setAccess(body.access ?? 'blocked');
      const confirmedPhrase = body.consentPhrase;
      if (confirmedPhrase)
        setState((current) => (current ? { ...current, consentPhrase: confirmedPhrase } : current));
      if (body.access === 'blocked') {
        setNotice({
          tone: 'info',
          text:
            body.message ??
            'La cuenta de Cortex todavía no tiene habilitada la creación de voces propias.',
        });
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setAccess('unknown');
      setNotice({ tone: 'error', text: (error as Error).message });
    }
  }

  async function preview(profileId: string | null) {
    if (creating || createLockRef.current) return;
    const controller = beginOperation();
    const key = profileId ?? 'bossa';
    previewAudioRef.current?.pause();
    setPreviewing(key);
    setNotice(null);
    try {
      if (profileId === null) {
        const audio = new Audio('/audio/cortex-bossa-preview.wav');
        previewAudioRef.current = audio;
        audio.onended = () => setPreviewing(null);
        audio.onerror = () => {
          setPreviewing(null);
          setNotice({
            tone: 'error',
            text: 'El navegador no pudo reproducir la muestra de Bossa.',
          });
        };
        await audio.play();
        return;
      }
      const res = await fetch(apiUrl(workspaceId, '/api/settings/voice/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
        signal: controller.signal,
      });
      if (!res.ok)
        throw new Error(await responseMessage(res, 'No pudimos generar la prueba de voz.'));
      const blob = await res.blob();
      if (controller.signal.aborted) return;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => setPreviewing(null);
      audio.onerror = () => {
        setPreviewing(null);
        setNotice({ tone: 'error', text: 'El navegador no pudo reproducir esta prueba.' });
      };
      await audio.play();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setPreviewing(null);
      setNotice({ tone: 'error', text: (error as Error).message });
    }
  }

  async function activate(profileId: string | null) {
    if (creating || createLockRef.current) return;
    const controller = beginOperation();
    const key = profileId ?? 'bossa';
    setActivating(key);
    setNotice(null);
    try {
      const res = await fetch(apiUrl(workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', profileId }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(await responseMessage(res, 'No pudimos cambiar la voz.'));
      setState((current) =>
        current
          ? {
              ...current,
              activeId: profileId,
              profiles: current.profiles.map((profile) => ({
                ...profile,
                active: profile.id === profileId,
              })),
            }
          : current,
      );
      setNotice({ tone: 'success', text: 'La voz quedó lista para las próximas llamadas.' });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setActivating(null);
    }
  }

  function replaceClip(kind: RecordingKind, clip: Clip | null) {
    const current = kind === 'consent' ? consent : sample;
    if (current) URL.revokeObjectURL(current.url);
    if (kind === 'consent') setConsent(clip);
    else setSample(clip);
  }

  async function createVoice() {
    if (creating || createLockRef.current || !consent || !sample || !confirmed || !name.trim())
      return;
    createLockRef.current = true;
    setCreating(true);
    setNotice(null);
    const controller = beginOperation();
    try {
      const form = new FormData();
      form.append('action', 'create');
      form.append('name', name.trim());
      form.append('language', 'es');
      form.append('consentConfirmed', 'true');
      form.append('consentRecording', consent.file);
      form.append('sampleRecording', sample.file);
      const res = await fetch(apiUrl(workspaceId), {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(await responseMessage(res, 'No pudimos crear la voz.'));
      const refreshed = await fetch(apiUrl(workspaceId), { signal: controller.signal });
      if (!refreshed.ok)
        throw new Error('La voz se creó, pero no pudimos actualizar la lista. Recarga la página.');
      setState((await refreshed.json()) as VoiceState);
      setName('');
      replaceClip('consent', null);
      replaceClip('sample', null);
      setConfirmed(false);
      setNotice({
        tone: 'success',
        text: 'La voz se creó. Pruébala y actívala cuando te guste cómo suena.',
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      createLockRef.current = false;
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparando las voces de {workspaceName}…
      </div>
    );
  }

  if (loadError || !state) {
    return (
      <Panel className="flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">No pudimos confirmar la voz activa</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {loadError ?? 'La respuesta de voces llegó incompleta.'} No cambiamos ninguna voz.
          </p>
        </div>
        <Button variant="outline" onClick={() => setReloadVersion((value) => value + 1)}>
          <RotateCcw className="h-4 w-4" /> Reintentar
        </Button>
      </Panel>
    );
  }

  const active = state.profiles.find((profile) => profile.id === state.activeId);
  const phrase = state.consentPhrase || FALLBACK_CONSENT;

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[28px] bg-[linear-gradient(120deg,#0c1020,#17203a)] px-6 py-7 text-white shadow-card sm:px-8">
        <div
          className="absolute inset-y-0 right-0 hidden w-1/2 opacity-25 sm:block"
          aria-hidden="true"
        >
          <Waveform />
        </div>
        <div className="relative max-w-xl">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-white">
            <Volume2 className="h-5 w-5" />
          </div>
          <p className="text-sm text-white/65">Voz actual en {workspaceName}</p>
          <h2 className="mt-1 text-3xl font-bold tracking-tight">{active?.name ?? 'Bossa'}</h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-white/70">
            {active
              ? 'Una voz propia de tu empresa.'
              : 'La voz cálida y clara incluida con Cortex.'}{' '}
            El cambio se aplica al comenzar la próxima llamada.
          </p>
          {state.canManage || !active ? (
            <Button
              variant="outline"
              className="mt-6 border-white/25 bg-white/10 text-white hover:bg-white/15"
              onClick={() => preview(active?.id ?? null)}
              disabled={previewing !== null || creating}
            >
              {previewing === (active?.id ?? 'bossa') ? (
                <>
                  <Pause className="h-4 w-4" /> Reproduciendo muestra…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" /> Escuchar muestra
                </>
              )}
            </Button>
          ) : (
            <p className="mt-5 text-xs text-white/60">
              Solo owner y admin pueden probar voces propias.
            </p>
          )}
        </div>
      </section>

      {notice && <NoticeBox notice={notice} />}

      <section>
        <div className="mb-3">
          <h2 className="text-sm font-bold text-ink">Voces disponibles</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Escucha una voz antes de elegirla. Cada empresa conserva su propia selección.
          </p>
        </div>
        <div className="space-y-3">
          <VoiceRow
            name="Bossa"
            detail="Voz original de Cortex · Español"
            active={!state?.activeId}
            busy={activating === 'bossa'}
            playing={previewing === 'bossa'}
            canPreview
            canManage={Boolean(state?.canManage)}
            locked={creating}
            onPreview={() => preview(null)}
            onActivate={() => activate(null)}
          />
          {state?.profiles.map((profile) => (
            <VoiceRow
              key={profile.id}
              name={profile.name}
              detail={`Voz propia · ${profile.language === 'es' ? 'Español' : profile.language}`}
              active={state.activeId === profile.id}
              busy={activating === profile.id}
              playing={previewing === profile.id}
              canPreview={state.canManage}
              canManage={state.canManage}
              locked={creating}
              onPreview={() => preview(profile.id)}
              onActivate={() => activate(profile.id)}
            />
          ))}
        </div>
      </section>

      {state?.canManage ? (
        <Panel className="overflow-hidden">
          <div className="border-b border-border bg-surface-2 px-5 py-5 sm:px-6">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-ink">Crear una voz propia</h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                  Dos grabaciones separadas permiten comprobar el consentimiento y aprender el
                  timbre. Los audios se usan para crear la voz; Cortex no los archiva en el Cerebro.
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-6 p-5 sm:p-6">
            {access === 'unknown' || access === 'checking' ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-2 p-4">
                <div>
                  <p className="text-sm font-semibold text-ink">
                    Comprueba que la cuenta puede crear voces
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    Toma unos segundos y no enciende el micrófono.
                  </p>
                </div>
                <Button onClick={checkAccess} disabled={access === 'checking' || creating}>
                  {access === 'checking' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Comprobando…
                    </>
                  ) : (
                    'Comprobar acceso'
                  )}
                </Button>
              </div>
            ) : access === 'blocked' ? (
              <div className="flex flex-wrap items-center gap-3 rounded-card border border-amber/25 bg-amber-soft p-4 text-sm text-ink">
                <LockKeyhole className="h-4 w-4 shrink-0 text-amber" />
                <p className="min-w-0 flex-1">
                  No pudimos confirmar que la cuenta de Cortex tenga habilitada la creación de
                  voces. Puedes seguir usando Bossa o una voz ya creada.
                </p>
                <Button variant="outline" onClick={checkAccess} disabled={creating}>
                  <RotateCcw className="h-4 w-4" /> Reintentar
                </Button>
              </div>
            ) : (
              <>
                <label className="block">
                  <span className="field-label">Nombre de la voz</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={48}
                    placeholder="Ej. Voz de recepción"
                    className="mt-2 w-full rounded-card border border-border-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                </label>
                <RecorderCard
                  kind="consent"
                  number="1"
                  title="Consentimiento"
                  instruction="La persona debe leer esta frase exacta, sin cambiar palabras:"
                  phrase={phrase}
                  clip={consent}
                  onChange={(clip) => replaceClip('consent', clip)}
                />
                <RecorderCard
                  kind="sample"
                  number="2"
                  title="Muestra en español"
                  instruction="Habla con naturalidad durante 10 a 30 segundos. Usa varias frases completas; se necesitan al menos 5 segundos de voz."
                  clip={sample}
                  onChange={(clip) => replaceClip('sample', clip)}
                />
                <label className="flex cursor-pointer items-start gap-3 rounded-card border border-border bg-surface-2 p-4">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span className="text-sm leading-relaxed text-ink">
                    Confirmo que una persona real autorizó crear esta voz y que ambas grabaciones
                    pertenecen a la misma persona.
                  </span>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                  <p className="max-w-lg text-xs leading-relaxed text-ink-muted">
                    La voz personalizada en español es experimental y debe probarse antes de
                    activarla. GPT-Live documenta específicamente los acentos personalizados en
                    inglés, así que no se garantiza una coincidencia exacta en español.
                  </p>
                  <Button
                    onClick={createVoice}
                    disabled={creating || !name.trim() || !consent || !sample || !confirmed}
                  >
                    {creating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Creando la voz…
                      </>
                    ) : (
                      'Crear voz para probar'
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Panel>
      ) : (
        <Panel className="flex items-start gap-3 p-5">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <div>
            <p className="text-sm font-semibold text-ink">
              La voz la administra quien gestiona esta empresa
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Puedes escuchar la voz actual. Una persona con rol de owner o admin puede crear y
              cambiar voces.
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}

function VoiceRow({
  name,
  detail,
  active,
  busy,
  playing,
  canPreview,
  canManage,
  locked,
  onPreview,
  onActivate,
}: {
  name: string;
  detail: string;
  active: boolean;
  busy: boolean;
  playing: boolean;
  canPreview: boolean;
  canManage: boolean;
  locked: boolean;
  onPreview: () => void;
  onActivate: () => void;
}) {
  return (
    <Panel
      className={clsx('flex flex-wrap items-center gap-4 px-5 py-4', active && 'border-primary/35')}
    >
      <span
        className={clsx(
          'grid h-10 w-10 place-items-center rounded-full',
          active ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted',
        )}
      >
        <Radio className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-ink">{name}</p>
          {active && (
            <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-[11px] font-semibold text-emerald">
              Activa
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        {canPreview ? (
          <Button variant="ghost" onClick={onPreview} disabled={playing || locked}>
            {playing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Headphones className="h-4 w-4" />
            )}{' '}
            Probar muestra
          </Button>
        ) : (
          <span className="px-2 text-xs text-ink-faint">Prueba solo para admin</span>
        )}
        {canManage && !active && (
          <Button variant="outline" onClick={onActivate} disabled={busy || locked}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{' '}
            Activar
          </Button>
        )}
      </div>
    </Panel>
  );
}

function RecorderCard({
  kind,
  number,
  title,
  instruction,
  phrase,
  clip,
  onChange,
}: {
  kind: RecordingKind;
  number: string;
  title: string;
  instruction: string;
  phrase?: string;
  clip: Clip | null;
  onChange: (clip: Clip | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(0);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state === 'recording') recorder.stop();
      }
      release();
    };
  }, [release]);

  async function accept(file: File, knownSeconds?: number) {
    if (!mountedRef.current) return;
    setError(null);
    const sizeError = recordingSizeError(file.size);
    if (sizeError) return setError(sizeError);
    try {
      const seconds = knownSeconds ?? (await audioDuration(file));
      if (!mountedRef.current) return;
      const durationError = recordingDurationError(kind, seconds);
      if (durationError) return setError(durationError);
      onChange({ file, seconds, url: URL.createObjectURL(file) });
    } catch {
      setError('No pudimos leer este audio. Prueba con MP3, M4A, WAV, WebM u OGG.');
    }
  }

  async function start() {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
      return setError('Este navegador no permite grabar aquí. Puedes subir un archivo de audio.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (stopStaleStream(stream, mountedRef.current, generationRef.current === generation)) return;
      streamRef.current = stream;
      chunksRef.current = [];
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = preferred
        ? new MediaRecorder(stream, { mimeType: preferred })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (!mountedRef.current || generationRef.current !== generation) {
          release();
          return;
        }
        const seconds = Math.min(MAX_RECORDING_SECONDS, (Date.now() - startedRef.current) / 1000);
        const type = recorder.mimeType || preferred || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const extension = type.startsWith('audio/mp4') ? 'm4a' : 'webm';
        release();
        setRecording(false);
        void accept(new File([blob], `${kind}.${extension}`, { type }), seconds);
      };
      startedRef.current = Date.now();
      setElapsed(0);
      recorder.start(500);
      setRecording(true);
      timerRef.current = setInterval(() => {
        const seconds = (Date.now() - startedRef.current) / 1000;
        setElapsed(seconds);
        if (seconds >= MAX_RECORDING_SECONDS && recorder.state === 'recording') recorder.stop();
      }, 200);
    } catch (caught) {
      release();
      if (!mountedRef.current || generationRef.current !== generation) return;
      const name = (caught as { name?: string }).name;
      setError(
        name === 'NotAllowedError'
          ? 'El micrófono está bloqueado. Permítelo desde el candado del navegador o sube un archivo.'
          : 'No pudimos abrir el micrófono. Puedes subir un archivo de audio.',
      );
    }
  }

  function stop() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }
  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void accept(file);
    event.target.value = '';
  }

  return (
    <div className="rounded-card border border-border p-4 sm:p-5">
      <div className="flex gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-white">
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{instruction}</p>
          {phrase && (
            <blockquote className="mt-3 rounded-card border-l-2 border-primary bg-primary-soft px-4 py-3 text-sm font-medium leading-relaxed text-ink">
              “{phrase}”
            </blockquote>
          )}
          <div className="mt-4">
            {clip ? (
              <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface-2 p-3">
                {/* A local recording preview has no separate caption track. */}
                {/* biome-ignore lint/a11y/useMediaCaption: the user just recorded this audio */}
                <audio controls src={clip.url} className="h-9 min-w-0 flex-1" />
                <span className="text-xs tabular text-ink-muted">
                  {formatDuration(clip.seconds)}
                </span>
                <Button variant="ghost" onClick={() => onChange(null)}>
                  <RotateCcw className="h-4 w-4" /> Repetir
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {recording ? (
                  <Button type="button" onClick={stop} className="bg-rose hover:bg-rose">
                    <CircleStop className="h-4 w-4" /> Detener · {formatDuration(elapsed)}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={start}>
                    <Mic className="h-4 w-4" /> Grabar con micrófono
                  </Button>
                )}
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2">
                  <Upload className="h-4 w-4" /> Subir audio
                  <input
                    type="file"
                    accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
                    onChange={upload}
                    className="sr-only"
                  />
                </label>
                <span className="text-xs text-ink-faint">Máx. 30 s · 2 MB</span>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs leading-relaxed text-rose">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  const styles =
    notice.tone === 'error'
      ? 'border-rose/25 bg-rose-soft text-rose'
      : notice.tone === 'success'
        ? 'border-emerald/25 bg-emerald-soft text-emerald'
        : 'border-amber/25 bg-amber-soft text-ink';
  return (
    <output
      className={clsx('flex items-start gap-2 rounded-card border px-4 py-3 text-sm', styles)}
    >
      {notice.tone === 'success' && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
      <p>{notice.text}</p>
    </output>
  );
}

function Waveform() {
  const bars = [
    ['a', 12],
    ['b', 28],
    ['c', 18],
    ['d', 42],
    ['e', 22],
    ['f', 54],
    ['g', 32],
    ['h', 68],
    ['i', 42],
    ['j', 82],
    ['k', 50],
    ['l', 66],
    ['m', 38],
    ['n', 74],
    ['o', 46],
    ['p', 58],
    ['q', 30],
    ['r', 48],
    ['s', 20],
    ['t', 34],
    ['u', 14],
  ] as const;
  return (
    <div className="flex h-full items-center justify-end gap-1 pr-8">
      {bars.map(([id, height]) => (
        <span key={id} className="w-1 rounded-full bg-white" style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}
