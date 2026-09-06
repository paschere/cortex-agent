'use client';
import { BrowserViewport } from '@/components/chat/results/BrowserLive';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Circle, Globe, Loader2, LockKeyhole, Plus, Square, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type StepDraft, StepEditor } from './StepEditor';

type Profile = { id: string; name: string; shared: boolean; owned: boolean };
type Lesson = Pick<StepDraft, 'steps' | 'variables'> & {
  active: boolean;
  limited: boolean;
  startUrl: string;
};
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data;
}
export function BrowserWorkspace() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [url, setUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [draft, setDraft] = useState<StepDraft | null>(null);
  const [name, setName] = useState('');
  const [noteIndex, setNoteIndex] = useState(0);
  const [noteText, setNoteText] = useState('');
  const [effect, setEffect] = useState<'read' | 'write'>('write');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const profile = profiles.find((p) => p.id === profileId);
  const load = useCallback(async () => {
    const data = await request('/api/browser/profiles');
    setProfiles(data.profiles);
    setProfileId((current) => current || data.profiles[0]?.id || '');
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  const perform = async (job: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!sessionId || !lesson?.active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = (await request(`/api/browser/live/${sessionId}/teaching`)) as Lesson;
        if (!cancelled) {
          setLesson(next);
          if (!next.active) setDraft({ steps: next.steps, variables: next.variables, sample: {} });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) timer = setTimeout(poll, 700);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, lesson?.active]);
  const teach = (op: 'start' | 'stop') =>
    perform(async () => {
      if (op === 'start') {
        setNoteIndex(0);
        setNoteText('');
      }
      const next = (await request(`/api/browser/live/${sessionId}/teaching`, 'POST', {
        op,
      })) as Lesson;
      setLesson(next);
      setDraft(op === 'stop' ? { steps: next.steps, variables: next.variables, sample: {} } : null);
    });
  return (
    <section
      className="mb-8 overflow-hidden rounded-xl border border-border bg-surface"
      aria-label="Navegador de Cortex"
    >
      <div className="border-b border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Globe className="h-5 w-5" /> Navegador de Cortex
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Tu sesión de trabajo. Abre un portal y enséñale el trámite a Cortex mientras lo haces.
            </p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1 text-xs">
            {profile?.shared ? (
              <Users className="h-3.5 w-3.5" />
            ) : (
              <LockKeyhole className="h-3.5 w-3.5" />
            )}
            {profile?.shared ? 'Compartido con la compañía' : 'Perfil privado'}
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <label className="text-sm" htmlFor="browser-profile">
            Perfil
          </label>
          <select
            id="browser-profile"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={profileId}
            disabled={busy || !!sessionId || !!draft}
            onChange={(e) => {
              setProfileId(e.target.value);
              setSharing(false);
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.shared ? 'compartido' : 'privado'}
                {p.owned ? '' : ' · de un compañero'}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            disabled={busy || !!sessionId || !!draft}
            onClick={() => setCreating(!creating)}
          >
            <Plus className="h-4 w-4" /> Nuevo perfil
          </Button>
          {profile?.owned && (
            <Button
              variant="ghost"
              disabled={busy || !!lesson?.active}
              onClick={() => setSharing(!sharing)}
            >
              Administrar acceso
            </Button>
          )}
        </div>
        {creating && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const created = await request('/api/browser/profiles', 'POST', { name: newName });
                await load();
                setProfileId(created.id);
                setCreating(false);
                setNewName('');
              });
            }}
          >
            <Input
              aria-label="Nombre del nuevo perfil"
              placeholder="Ej. Operaciones"
              value={newName}
              maxLength={100}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button disabled={busy || !newName.trim()}>Crear privado</Button>
          </form>
        )}
        {sharing && profile?.owned && (
          <div className="mt-3 rounded-lg border border-border p-4 text-sm">
            <p>
              {profile.shared
                ? 'Al volverlo privado, sólo tú podrás usar este perfil y sus trámites.'
                : 'La compañía podrá usar las cuentas que hayas dejado abiertas en este perfil y sus trámites. Tu navegador personal seguirá separado.'}{' '}
              Las pestañas abiertas de este perfil se cerrarán al cambiar el acceso.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await request('/api/browser/profiles', 'PATCH', {
                      id: profile.id,
                      shared: !profile.shared,
                    });
                    setSessionId('');
                    setSharing(false);
                    await load();
                  })
                }
              >
                {profile.shared ? 'Volver privado' : 'Compartir con la compañía'}
              </Button>
              <Button variant="ghost" onClick={() => setSharing(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
        {!sessionId && (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const data = await request('/api/browser/live', 'POST', {
                  profileId,
                  startUrl: /^https?:\/\//.test(url) ? url : `https://${url}`,
                });
                setSessionId(data.sessionId);
                await request(`/api/browser/live/${data.sessionId}`, 'POST', { op: 'take' });
                setLesson(null);
                setDraft(null);
              });
            }}
          >
            <Input
              aria-label="Dirección del portal"
              placeholder="Dirección del portal, ej. https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button disabled={busy || !profileId || !url.trim() || !!draft}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Abrir portal'}
            </Button>
          </form>
        )}
      </div>
      {error && (
        <p role="alert" className="m-4 rounded-md border border-red-300 p-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <output className="m-4 block rounded-md border border-border p-3 text-sm">{notice}</output>
      )}
      {sessionId && (
        <div className="p-4">
          <form
            className="mb-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const next = await request(`/api/browser/live/${sessionId}/teaching`, 'POST', {
                  op: 'navigate',
                  url: /^https?:\/\//.test(url) ? url : `https://${url}`,
                });
                if (lesson) setLesson(next);
              });
            }}
          >
            <Input
              aria-label="Ir a otro sitio"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Pega la dirección del siguiente sitio"
            />
            <Button disabled={busy || !!draft || !url.trim()}>Ir</Button>
          </form>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                disabled={busy || !!draft}
                onClick={() => void teach(lesson?.active ? 'stop' : 'start')}
              >
                {lesson?.active ? <Square className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                {lesson?.active ? 'Terminar enseñanza' : 'Enseñar este trámite'}
              </Button>
              <span className="text-xs text-ink-muted">
                {lesson?.active
                  ? 'Aprendiendo en vivo'
                  : 'Inicia sesión primero; enseña cuando estés listo.'}
              </span>
            </div>
            <Button
              variant="ghost"
              disabled={busy || !!lesson?.active}
              onClick={() =>
                void perform(async () => {
                  await request(`/api/browser/live/${sessionId}`, 'DELETE');
                  setSessionId('');
                })
              }
            >
              <X className="h-4 w-4" /> Cerrar portal
            </Button>
          </div>
          <div
            className={`grid min-w-0 grid-cols-1 gap-4 ${lesson?.active ? 'xl:grid-cols-[minmax(0,1fr)_260px]' : ''}`}
          >
            <BrowserViewport key={sessionId} sessionId={sessionId} teaching={!!lesson?.active} />
            {lesson?.active && (
              <aside className="min-w-0 max-h-[650px] overflow-auto rounded-lg border border-border p-4">
                <h3 className="text-sm font-medium">Pasos aprendidos · {lesson.steps.length}</h3>
                <p className="mt-1 text-xs text-ink-muted">
                  Los campos se guardan como variables, sin sus valores.
                </p>
                <ol className="mt-4 space-y-3">
                  {lesson.steps.map((step, i) => (
                    <li key={`${i}-${step.action}`} className="flex gap-2 text-sm">
                      <span className="text-ink-muted">{i + 1}.</span>
                      <span className="min-w-0 flex-1">
                        {step.label}
                        {step.explanation && (
                          <span className="mt-1 block whitespace-pre-wrap text-xs text-ink-muted">
                            {step.explanation}
                          </span>
                        )}
                        <button
                          type="button"
                          className="mt-1 block text-xs text-primary"
                          onClick={() => {
                            setNoteIndex(i);
                            setNoteText(step.explanation ?? '');
                          }}
                        >
                          Explicar este paso
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
                <form
                  className="mt-5 border-t border-border pt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      const next = await request(
                        `/api/browser/live/${sessionId}/teaching`,
                        'POST',
                        { op: 'explain', index: noteIndex, text: noteText },
                      );
                      setLesson(next);
                      setNotice('Explicación vinculada al paso.');
                    });
                  }}
                >
                  <label htmlFor="teaching-explanation" className="text-sm font-medium">
                    Explica el paso {noteIndex + 1}
                  </label>
                  <textarea
                    id="teaching-explanation"
                    className="mt-2 min-h-32 w-full rounded-md border border-border bg-surface p-2 text-sm"
                    maxLength={2000}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Ej. En Drive tomo el NIT de la columna B del cliente y lo uso en la consulta de la DIAN."
                  />
                  <p className="my-2 text-xs text-ink-muted">
                    Indica de dónde sale el dato y para qué se usa. La explicación aporta contexto;
                    no configura una lectura automática de Drive.
                  </p>
                  <Button disabled={busy}>Añadir explicación</Button>
                </form>
              </aside>
            )}
          </div>
        </div>
      )}
      {draft && lesson && (
        <div className="border-t border-border p-5">
          <h3 className="font-semibold">Revisa lo que Cortex aprendió</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Guardar crea una propuesta. La prueba se inicia después desde el trámite.{' '}
            {lesson.limited
              ? 'Se alcanzó el límite de la enseñanza; divide el trámite antes de guardarlo.'
              : ''}
          </p>
          <div className="my-4 grid gap-3 md:grid-cols-2">
            <label className="text-sm" htmlFor="lesson-name">
              Nombre del trámite
              <Input
                id="lesson-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej. Consultar un certificado"
              />
            </label>
            <label className="text-sm">
              Qué hace
              <select
                className="block w-full rounded-md border border-border bg-surface p-2"
                value={effect}
                onChange={(e) => setEffect(e.target.value as 'read' | 'write')}
              >
                <option value="write">Envía o modifica información</option>
                <option value="read">Sólo consulta información</option>
              </select>
            </label>
            <label className="text-sm md:col-span-2" htmlFor="lesson-start-url">
              Dirección de inicio
              <Input
                id="lesson-start-url"
                value={lesson.startUrl}
                onChange={(e) => setLesson({ ...lesson, startUrl: e.target.value })}
              />
              <span className="text-xs text-ink-muted">
                Se quitaron parámetros de sesión de la dirección. Revisa que abra la pantalla
                correcta.
              </span>
            </label>
          </div>
          <StepEditor value={draft} onChange={setDraft} />
          <div className="mt-4 flex gap-2">
            <Button
              disabled={busy || !name.trim() || lesson.limited}
              onClick={() =>
                void perform(async () => {
                  const saved = await request('/api/browser/flows', 'POST', {
                    liveTeaching: true,
                    profileId,
                    proposal: {
                      name,
                      description: '',
                      startUrl: lesson.startUrl,
                      effect,
                      steps: draft.steps,
                      variables: draft.variables,
                    },
                  });
                  setNotice(saved.message);
                  setDraft(null);
                  setLesson(null);
                  setName('');
                  if (sessionId) {
                    await request(`/api/browser/live/${sessionId}`, 'DELETE');
                    setSessionId('');
                  }
                  window.dispatchEvent(new Event('browser-flows-changed'));
                })
              }
            >
              Guardar propuesta
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setLesson(null);
              }}
            >
              Descartar enseñanza
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
