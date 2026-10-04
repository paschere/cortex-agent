'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import { authClient } from '@/lib/auth-client';
import { describeDevice } from '@/lib/security/user-agent';
import { Laptop, Loader2, MonitorSmartphone, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * Las sesiones abiertas de esta cuenta, con la salida de cada una.
 *
 * La lista y los cierres son de better-auth (`listSessions`, `revokeSession`,
 * `revokeOtherSessions`): lo que se ve es lo que el servidor guarda. Una
 * salvedad que se dice en pantalla: la sesión se guarda también en una cookie
 * firmada de corta vida (5 min, ver `cookieCache` en lib/auth.ts), así que un
 * dispositivo cerrado desde aquí puede seguir entrando unos minutos más.
 */

interface SessionRow {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const dateFormat = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (list.error || !list.data) {
      setError('No se pudieron leer tus sesiones. Recarga la pantalla.');
      return;
    }
    setError(null);
    setCurrentToken(current.data?.session?.token ?? null);
    setSessions(
      [...(list.data as SessionRow[])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: string) {
    setBusy(token);
    setError(null);
    const { error: failure } = await authClient.revokeSession({ token });
    if (failure) setError('No se pudo cerrar esa sesión. Inténtalo de nuevo.');
    // Cerrar la sesión propia saca a la persona de la app.
    if (!failure && token === currentToken) {
      window.location.assign('/login');
      return;
    }
    await load();
    setBusy(null);
  }

  async function revokeOthers() {
    setBusy('others');
    setError(null);
    const { error: failure } = await authClient.revokeOtherSessions();
    if (failure) setError('No se pudieron cerrar las demás sesiones. Inténtalo de nuevo.');
    await load();
    setBusy(null);
  }

  const others = (sessions ?? []).filter((session) => session.token !== currentToken);

  return (
    <Panel>
      <PanelHead
        title="Sesiones abiertas"
        icon={<MonitorSmartphone className="h-4 w-4" />}
        right={
          others.length > 0 && (
            <Button
              variant="outline"
              className="min-h-8 px-3 py-1 text-xs"
              onClick={() => void revokeOthers()}
              disabled={busy !== null}
            >
              {busy === 'others' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Cerrar todas las demás
            </Button>
          )
        }
      />
      <div className="px-6 pb-6 pt-3">
        <p className="mb-3 text-sm text-ink-muted">
          Los dispositivos donde tu cuenta está abierta ahora. Cierra los que no reconozcas o ya no
          uses. Un dispositivo cerrado puede tardar unos minutos en perder el acceso.
        </p>
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
          >
            {error}
          </p>
        )}
        {sessions === null && !error ? (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Cargando…
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {(sessions ?? []).map((session) => {
              const device = describeDevice(session.userAgent);
              const current = session.token === currentToken;
              const Icon = device.mobile ? Smartphone : Laptop;
              return (
                <li key={session.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                      {device.label}
                      {current && (
                        <span className="rounded-pill border border-emerald/30 bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald">
                          Esta sesión
                        </span>
                      )}
                    </div>
                    <div className="tabular text-micro text-ink-faint">
                      {session.ipAddress ? `IP ${session.ipAddress} · ` : ''}
                      activa por última vez {dateFormat.format(new Date(session.updatedAt))} ·
                      abierta {dateFormat.format(new Date(session.createdAt))}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    className="min-h-8 px-3 py-1 text-xs hover:text-rose"
                    onClick={() => void revoke(session.token)}
                    disabled={busy !== null}
                  >
                    {busy === session.token && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    )}
                    {current ? 'Cerrar esta sesión' : 'Cerrar'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
