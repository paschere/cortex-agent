'use client';

import { chipClass } from '@/lib/status-chip';
import { SHARE_DEFAULT_DAYS } from '@/lib/task-share/shape';
import { Check, Copy, Link2, Loader2, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ShareItem {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  shots: number;
  hidePersonal: boolean;
  state: 'active' | 'expired' | 'revoked';
  createdAt: string;
}

const dayFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});
const when = (iso: string) => dayFmt.format(new Date(iso)).replace(/[  ]/g, ' ');

const STATE_LABEL = { active: 'Activo', expired: 'Vencido', revoked: 'Revocado' } as const;

export const shareBtn =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border disabled:opacity-50 motion-reduce:transition-none';

/**
 * «COMPARTIR REPETICIÓN»: un enlace público, de sólo lectura, a lo que hizo una
 * tarea (plan, pasos, capturas y respuesta). Se ve quién lo abrió cuántas veces
 * y se revoca con un clic. El enlace en claro sale una sola vez, al crearlo.
 */
export function ShareReplay({
  taskId,
  label = 'Compartir repetición',
  fixture = false,
}: {
  taskId: string;
  label?: string;
  fixture?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(SHARE_DEFAULT_DAYS);
  const [hidePersonal, setHidePersonal] = useState(true);
  const [includeShots, setIncludeShots] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareItem[] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (fixture) {
      setShares([]);
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}/share`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { shares?: ShareItem[] };
      setShares(body.shares ?? []);
    } catch {
      // Se reintenta al reabrir.
    }
  }, [taskId, fixture]);

  useEffect(() => {
    if (!open) return;
    void load();
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, load]);

  async function create() {
    setBusy(true);
    setError(null);
    setUrl(null);
    try {
      if (fixture) {
        setUrl('https://cortex.example/r/Zk3pQ9vLm2XcT7bNd4HsW8yRa1EfGu6J');
        return;
      }
      const res = await fetch(`/api/tasks/${taskId}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days, hidePersonal, includeShots }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? 'No se pudo crear el enlace.');
        return;
      }
      setUrl(body.url);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (fixture) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/share/${id}`, { method: 'DELETE' });
      if (!res.ok) setError('No se pudo revocar el enlace.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No pude copiarlo; selecciónalo y cópialo a mano.');
    }
  }

  return (
    <>
      <button type="button" className={shareBtn} onClick={() => setOpen(true)}>
        <Share2 className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: modal propio con su Escape y su foco */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Compartir la repetición de la tarea"
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-card border border-border bg-surface p-5 shadow-card sm:rounded-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink">Compartir repetición</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Un enlace de sólo lectura con el plan, los pasos, las capturas y la respuesta de
                  esta tarea. No muestra claves ni el resto de la conversación.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-3 text-sm text-ink">
              <label className="flex items-center justify-between gap-3">
                <span>Vence en</span>
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="min-h-9 rounded-input border border-border-strong bg-surface px-2.5 text-sm"
                >
                  <option value={1}>1 día</option>
                  <option value={7}>7 días</option>
                  <option value={30}>30 días</option>
                </select>
              </label>
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={hidePersonal}
                  onChange={(e) => setHidePersonal(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  Ocultar datos personales
                  <span className="block text-xs text-ink-faint">
                    Correos, teléfonos y NIT salen como «[oculto]» en el texto.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={includeShots}
                  onChange={(e) => setIncludeShots(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  Incluir capturas de pantalla
                  <span className="block text-xs text-ink-faint">
                    Las imágenes no se pueden ocultar: revísalas antes de compartir.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void create()}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-ink disabled:opacity-60"
              >
                {busy ? (
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Link2 className="h-4 w-4" aria-hidden />
                )}
                Crear enlace
              </button>
            </div>

            {url && (
              <div className="mt-3 rounded-card border border-emerald/30 bg-emerald-soft p-3">
                <p className="text-xs font-semibold text-ink">
                  Copia el enlace ahora: no se vuelve a mostrar.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-h-9 min-w-0 flex-1 rounded-input border border-border-strong bg-surface px-2.5 text-xs"
                    aria-label="Enlace de la repetición"
                  />
                  <button type="button" onClick={() => void copy()} className={shareBtn}>
                    {copied ? (
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {copied ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            )}
            {error && (
              <p className="mt-3 text-sm text-rose" role="alert">
                {error}
              </p>
            )}

            {shares && shares.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  Enlaces de esta tarea
                </h3>
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {shares.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                    >
                      <div className="min-w-0 text-sm text-ink">
                        <span
                          className={chipClass(
                            s.state === 'active'
                              ? 'emerald'
                              : s.state === 'revoked'
                                ? 'rose'
                                : 'neutral',
                          )}
                        >
                          {STATE_LABEL[s.state]}
                        </span>
                        <span className="tabular ml-2 text-xs text-ink-muted">
                          {s.state === 'active'
                            ? `vence ${when(s.expiresAt)}`
                            : `creado ${when(s.createdAt)}`}
                          {' · '}
                          {s.viewCount} {s.viewCount === 1 ? 'vista' : 'vistas'}
                          {s.shots > 0 ? ` · ${s.shots} capturas` : ''}
                        </span>
                      </div>
                      {s.state === 'active' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void revoke(s.id)}
                          className={shareBtn}
                        >
                          Revocar
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
