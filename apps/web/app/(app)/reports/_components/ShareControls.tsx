'use client';

import { Button } from '@/components/ui/button';
import { clsx } from 'clsx';
import { Check, Copy, Link2, Link2Off, Loader2, ShieldOff } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { revokeShareAction, shareReportAction } from '../actions';

/**
 * The share control: mint a link, copy it, or kill it.
 *
 * THE SENTENCE MATTERS MORE THAN THE BUTTON. Whoever holds this link can open
 * the report — there is no password, because a link that demanded a Cortex
 * session would be unusable the moment it left the app, which is the only place
 * it is ever going. So the screen says that, plainly, next to the link rather
 * than buried in a tooltip, and it says when the link dies.
 *
 * Re-sharing replaces the previous token instead of extending it. "Compartir de
 * nuevo" almost always follows "creo que ese enlace le llegó a quien no era",
 * and silently renewing the old one would leave that person holding a live door.
 *
 * ===========================================================================
 * CUANDO NO HAY BOTÓN
 * ===========================================================================
 * Un informe a la medida puede llevar un bloque que nombra a personas del
 * equipo, y ése no sale por un enlace sin contraseña. La pantalla no enseña el
 * botón deshabilitado con un tooltip: enseña la razón. Un botón apagado invita
 * a buscar la forma de encenderlo; una frase que dice por qué cierra la
 * pregunta y además explica qué SÍ se puede hacer.
 *
 * No es esto lo que impide compartirlo — lo impide un CHECK de la 0107 y, antes
 * de llegar ahí, `shareReport`. Esto es lo que lo explica.
 */
export function ShareControls({
  reportId,
  initialUrl,
  initialExpiresLabel,
  views,
  restricted = false,
}: {
  reportId: string;
  initialUrl: string | null;
  initialExpiresLabel: string | null;
  views: number;
  restricted?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [expiresLabel, setExpiresLabel] = useState<string | null>(initialExpiresLabel);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const share = () => {
    setError(null);
    startTransition(async () => {
      const result = await shareReportAction(reportId, 30);
      if (!result.ok || !result.url) {
        setError(result.error ?? 'No se pudo crear el enlace.');
        return;
      }
      setUrl(result.url);
      setExpiresLabel(
        result.expiresAt ? new Date(result.expiresAt).toLocaleDateString('es-CO') : null,
      );
    });
  };

  const revoke = () => {
    setError(null);
    startTransition(async () => {
      const result = await revokeShareAction(reportId);
      if (!result.ok) {
        setError(result.error ?? 'No se pudo revocar el enlace.');
        return;
      }
      setUrl(null);
      setExpiresLabel(null);
    });
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('El navegador no dejó copiar. Selecciona el enlace y cópialo a mano.');
    }
  };

  if (restricted) {
    return (
      <div className="flex items-start gap-3 rounded-card border border-amber/20 bg-amber-soft p-4">
        <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-amber">
            Este informe no sale por enlace público
          </p>
          <p className="mt-1 max-w-prose text-xs leading-snug text-ink-muted">
            Nombra a personas del equipo, y el enlace público no pide contraseña: quien lo tenga, lo
            abre. Adentro se ve entero — manda el enlace de esta página, que sí pide sesión, o
            expórtalo y entrégalo a mano.
          </p>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={share} disabled={pending}>
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Link2 className="h-3.5 w-3.5" aria-hidden />
          )}
          Compartir
        </Button>
        {error && (
          <p role="alert" className="mt-2 text-xs text-rose">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-card border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="tabular min-w-0 flex-1 truncate rounded-sm bg-surface px-2.5 py-1.5 text-micro text-ink-muted">
          {url}
        </code>
        <Button type="button" variant="outline" onClick={copy} className="shrink-0">
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={revoke}
          disabled={pending}
          className="shrink-0"
        >
          <Link2Off className="h-3.5 w-3.5" aria-hidden />
          Revocar
        </Button>
      </div>
      <p className={clsx('mt-2 text-micro leading-snug text-ink-faint')}>
        Quien tenga el enlace puede abrirlo, sin contraseña. Muestra la misma fotografía guardada.
        {expiresLabel ? ` Vence el ${expiresLabel}.` : ''}
        {views > 0 ? ` Se ha abierto ${views} ${views === 1 ? 'vez' : 'veces'}.` : ''}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-rose">
          {error}
        </p>
      )}
    </div>
  );
}
