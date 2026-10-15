'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, Copy, Loader2, MonitorCheck, ShieldCheck, Unplug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  type ChromeState,
  createPairingCodeAction,
  readChromeState,
  removeSiteAction,
  revokeDeviceAction,
} from './actions';

// 24 horas a propósito: «p. m.» lleva un espacio fino que el servidor y el
// navegador escriben distinto y rompe la hidratación.
const when = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'America/Bogota',
});

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary-ink"
      >
        {n}
      </span>
      <div className="min-w-0 text-[0.9375rem] leading-relaxed text-ink-muted">{children}</div>
    </li>
  );
}

export function ChromePanel({ initial }: { initial: ChromeState }) {
  const [state, setState] = useState<ChromeState>(initial);
  const [code, setCode] = useState<{ value: string; expiresAt: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(0);
  const [pending, start] = useTransition();

  const refresh = useCallback(async () => {
    try {
      setState(await readChromeState());
    } catch {
      // Una lectura fallida no borra lo que ya se ve.
    }
  }, []);

  // Con un código a la vista, miramos si la extensión ya lo canjeó.
  const knownIds = useRef<Set<string>>(new Set(initial.devices.map((d) => d.id)));
  useEffect(() => {
    knownIds.current = new Set(state.devices.map((d) => d.id));
  }, [state.devices]);
  useEffect(() => {
    if (!code) return;
    const known = new Set(knownIds.current);
    const t = window.setInterval(async () => {
      const next = await readChromeState().catch(() => null);
      if (!next) return;
      setState(next);
      if (next.devices.some((d) => !known.has(d.id))) {
        setCode(null);
        setNote('Listo: tu Chrome quedó emparejado.');
      }
    }, 3_000);
    return () => window.clearInterval(t);
  }, [code]);

  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const s = Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setCode(null);
    };
    tick();
    const t = window.setInterval(tick, 1_000);
    return () => window.clearInterval(t);
  }, [code]);

  // El estado de conexión cambia solo (la extensión late cada ~20 s).
  useEffect(() => {
    const t = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const makeCode = () =>
    start(async () => {
      setNote(null);
      const r = await createPairingCodeAction();
      if (r.ok) setCode({ value: r.code, expiresAt: new Date(r.expiresAt).getTime() });
      else setNote(r.note);
    });

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      // Sin portapapeles: el código está a la vista para copiarlo a mano.
    }
  };

  const revoke = (id: string, name: string) => {
    if (
      !window.confirm(`¿Desvincular «${name}»? Cortex deja de poder usar ese Chrome al instante.`)
    )
      return;
    start(async () => {
      await revokeDeviceAction(id);
      await refresh();
    });
  };

  const removeSite = (id: string) =>
    start(async () => {
      await removeSiteAction(id);
      await refresh();
    });

  const live = state.devices.filter((d) => !d.revoked);
  const mm = String(Math.floor(left / 60)).padStart(1, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="flex max-w-[56rem] flex-col gap-6">
      {/* ---- Tus Chrome ------------------------------------------------------ */}
      <Panel className="pb-5">
        <PanelHead icon={<MonitorCheck className="h-4 w-4" />} title="Tus Chrome" />
        <div className="px-6 pt-3">
          {live.length === 0 ? (
            <p className="text-[0.9375rem] text-ink-muted">
              Todavía no hay ningún Chrome emparejado. Sigue los pasos de abajo.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {live.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <span
                    aria-hidden
                    className={clsx(
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      d.online ? 'bg-emerald' : 'bg-border-strong',
                    )}
                  />
                  <div className="min-w-[12rem] flex-1">
                    <p className="font-semibold text-ink [overflow-wrap:anywhere]">{d.name}</p>
                    <p className="text-[0.8125rem] text-ink-faint">
                      {d.online
                        ? 'Conectado ahora'
                        : d.lastSeenAt
                          ? `Última vez: ${when.format(new Date(d.lastSeenAt))}`
                          : 'Aún no se ha conectado'}
                      {d.extVersion ? ` · extensión ${d.extVersion}` : ''}
                      {` · vence ${when.format(new Date(d.expiresAt))}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(d.id, d.name)}
                    disabled={pending}
                    className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3.5 text-sm font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-50"
                  >
                    <Unplug className="h-3.5 w-3.5" aria-hidden />
                    Desvincular
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {/* ---- Instalar y emparejar -------------------------------------------- */}
      <Panel className="pb-6">
        <PanelHead title="Instalar y emparejar" />
        <ol className="flex flex-col gap-4 px-6 pt-4">
          <Step n={1}>
            <strong className="text-ink">Instala la extensión.</strong> Por ahora se carga a mano:
            en una terminal del proyecto corre{' '}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.8125rem]">
              pnpm --filter @cortex/extension build
            </code>
            , abre{' '}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.8125rem]">
              chrome://extensions
            </code>
            , activa «Modo de desarrollador», pulsa «Cargar descomprimida» y elige la carpeta{' '}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.8125rem]">
              apps/extension/dist
            </code>
            . Más adelante estará en la Chrome Web Store.
          </Step>
          <Step n={2}>
            <strong className="text-ink">Crea tu código.</strong> Dura 10 minutos y sirve una sola
            vez.
            <div className="mt-3">
              {code ? (
                <div className="flex flex-wrap items-center gap-3">
                  <output
                    aria-live="polite"
                    className="rounded-sm border border-border-strong bg-surface-2 px-4 py-2 font-mono text-2xl font-bold tracking-[0.18em] text-ink"
                  >
                    {code.value}
                  </output>
                  <button
                    type="button"
                    onClick={copy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-border px-3.5 text-sm font-semibold text-ink-muted hover:bg-surface-2"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {copied ? 'Copiado' : 'Copiar'}
                  </button>
                  <span className="tabular text-sm text-ink-faint">
                    Vence en {mm}:{ss}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={makeCode}
                  disabled={pending}
                  className="inline-flex h-10 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-60"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Crear código
                </button>
              )}
            </div>
          </Step>
          <Step n={3}>
            <strong className="text-ink">Escríbelo en la extensión.</strong> Pulsa el icono de
            Cortex en la barra de Chrome, se abre el panel lateral; pega el código y pulsa
            «Emparejar». Esta pantalla se actualiza sola cuando queda.
          </Step>
        </ol>
        {note ? (
          <output className="block px-6 pt-4 text-sm font-medium text-ink">{note}</output>
        ) : null}
      </Panel>

      {/* ---- Sitios ----------------------------------------------------------- */}
      <Panel className="pb-5">
        <PanelHead icon={<ShieldCheck className="h-4 w-4" />} title="Sitios que decidiste" />
        <div className="px-6 pt-3">
          {state.sites.length === 0 ? (
            <p className="text-[0.9375rem] text-ink-muted">
              Aún no has decidido ninguno. La primera vez que Cortex quiera trabajar en un sitio, la
              extensión te pregunta: «solo esta vez», «siempre» o «nunca».
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {state.sites.map((s) => {
                const device = state.devices.find((d) => d.id === s.deviceId);
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                    <span className="min-w-[9rem] flex-1 font-semibold text-ink [overflow-wrap:anywhere]">
                      {s.site}
                    </span>
                    <span className={chipClass(s.decision === 'always' ? 'emerald' : 'rose')}>
                      {s.decision === 'always' ? 'Siempre permitido' : 'Nunca'}
                    </span>
                    {device ? <span className="text-xs text-ink-faint">{device.name}</span> : null}
                    <button
                      type="button"
                      onClick={() => removeSite(s.id)}
                      disabled={pending}
                      className="h-8 rounded-pill px-3 text-sm font-semibold text-ink-muted hover:bg-surface-2 disabled:opacity-50"
                    >
                      Quitar
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-[0.8125rem] text-ink-faint">
            Al quitar un sitio, Cortex vuelve a preguntarte la próxima vez (la extensión lo olvida
            en menos de un minuto).
          </p>
        </div>
      </Panel>

      {/* ---- Cómo se cuida --------------------------------------------------- */}
      <Panel className="pb-6">
        <PanelHead title="Cómo se cuida esto" />
        <ul className="flex list-disc flex-col gap-2 px-6 pl-10 pt-3 pr-6 text-[0.9375rem] leading-relaxed text-ink-muted">
          <li>Cada vez que Cortex quiere entrar a tu Chrome, te lo pregunta en el chat.</li>
          <li>
            Cada sitio nuevo lo apruebas tú en una ventanita de la extensión. Nunca actúa en páginas
            del navegador, en tu red privada ni en Cortex mismo.
          </li>
          <li>
            Las contraseñas y los códigos los escribes tú directo en la página: Cortex no los ve.
            Los campos de clave ni siquiera se leen.
          </li>
          <li>
            Verás una franja en la pestaña —«Cortex está trabajando aquí · Detener»— y un botón
            «Detener» que corta todo al instante.
          </li>
          <li>Cada sesión tiene un tope de acciones y todo queda en la auditoría.</li>
          <li>El emparejamiento se puede revocar desde aquí y vence solo a los 90 días sin uso.</li>
        </ul>
      </Panel>
    </div>
  );
}
