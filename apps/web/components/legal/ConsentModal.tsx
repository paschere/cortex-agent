'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import {
  LEGAL_DOCUMENT_PATH,
  LEGAL_DOCUMENT_TITLE,
  LEGAL_DOCUMENT_VERSIONS,
  type LegalDocument,
} from '@/lib/legal/versions';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * El aviso bloqueante. Casilla SIN marcar (la autorización tiene que ser un acto
 * de la persona, no un valor por defecto), enlaces a los textos completos en
 * pestaña nueva, y dos salidas: aceptar o cerrar sesión. No se cierra con Esc
 * ni haciendo clic fuera.
 */
export function ConsentModal({
  missing,
  updated,
}: {
  missing: LegalDocument[];
  updated: boolean;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/legal/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          documents: missing.map((d) => ({ document: d, version: LEGAL_DOCUMENT_VERSIONS[d] })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'No se pudo guardar tu autorización. Inténtalo de nuevo.');
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo guardar tu autorización.');
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await authClient.signOut().catch(() => null);
    window.location.href = '/';
  }

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/50 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="legal-consent-title"
        aria-describedby="legal-consent-body"
        tabIndex={-1}
        className="w-full max-w-lg rounded-card border border-border bg-surface p-6 shadow-card outline-none"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="legal-consent-title" className="text-base font-bold text-ink">
              {updated ? 'Actualizamos cómo tratamos tus datos' : 'Antes de seguir'}
            </h2>
            <p id="legal-consent-body" className="mt-1 text-sm leading-relaxed text-ink-muted">
              {updated
                ? 'Cambiamos documentos que necesitan tu autorización. Léelos y, si estás de acuerdo, acéptalos para seguir usando Cortex.'
                : 'Para usar Cortex necesitamos tu autorización para tratar tus datos personales, conforme a la Ley 1581 de 2012.'}
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-1.5 text-sm">
          {missing.map((d) => (
            <li key={d}>
              <a
                href={LEGAL_DOCUMENT_PATH[d]}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary hover:underline"
              >
                {LEGAL_DOCUMENT_TITLE[d]}
              </a>{' '}
              <span className="text-xs text-ink-faint">versión {LEGAL_DOCUMENT_VERSIONS[d]}</span>
            </li>
          ))}
          <li>
            <a
              href={LEGAL_DOCUMENT_PATH.privacidad}
              target="_blank"
              rel="noreferrer"
              className="text-ink-muted hover:underline"
            >
              {LEGAL_DOCUMENT_TITLE.privacidad}
            </a>
          </li>
        </ul>

        <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-card border border-border bg-surface-2 p-3 text-sm leading-relaxed text-ink">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>
            Leí y acepto los documentos de arriba, y autorizo de manera previa, expresa e informada
            el tratamiento de mis datos personales para las finalidades que allí se describen.
          </span>
        </label>

        {err && (
          <p role="alert" className="mt-3 text-sm text-rose">
            {err}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={signOut} disabled={busy}>
            Cerrar sesión
          </Button>
          <Button type="button" onClick={accept} disabled={!checked || busy}>
            {busy ? 'Guardando…' : 'Aceptar y continuar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
