'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { shortDay } from '@/lib/statements/format';
import { clsx } from 'clsx';
import { ArrowLeft, Copy, Download, Link2, Loader2, Lock, RefreshCw, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { BoardDocument } from './BoardDocument';
import type { BoardDetailProps } from './types';

/**
 * Un informe para socios (0191): el documento, y al lado lo que se hace con
 * él — bajar el PDF, volver a armarlo, compartir el enlace (con contraseña si
 * se quiere) y mandarlo por correo. Mandar lo aprueba quien pulsa el botón
 * (el diálogo ES la aprobación) y corre por `board.send`, igual que en el chat.
 */
export function BoardDetail(props: BoardDetailProps) {
  const { report } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={props.links.list}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Informes para socios
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className={statusPill(report.status === 'enviado' ? 'emerald' : 'amber')}>
            {report.status === 'enviado' ? `Enviado el ${shortDay(report.sentAt)}` : 'Borrador'}
          </span>
          {report.fallback && <span className={statusPill('neutral')}>Resumen de plantilla</span>}
          <a href={props.links.pdf} className={pillLink}>
            <Download className="h-3.5 w-3.5" aria-hidden /> PDF
          </a>
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel className="p-5 sm:p-8">
          <BoardDocument content={report.content} />
        </Panel>
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          {props.canEdit ? (
            <>
              <SendPanel {...props} />
              <SharePanel {...props} />
              <RegeneratePanel {...props} />
            </>
          ) : (
            <Panel className="p-5 text-sm text-ink-muted">
              Compartirlo y mandarlo lo hace quien administra la empresa.
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}

function SendPanel(props: BoardDetailProps) {
  const router = useRouter();
  const [to, setTo] = useState(props.recipients.join(', '));
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const list = to
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <Panel className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <Send className="h-4 w-4 text-primary" aria-hidden /> Mandar a los socios
      </h2>
      <p className="mt-1 text-micro text-ink-muted">
        Sale desde tu Gmail u Outlook con el resumen y el enlace al informe
        {props.report.visibility === 'contrasena' ? ' (con contraseña: compártela por aparte)' : ''}
        .
      </p>
      <label className="mt-3 block text-xs font-semibold text-ink-muted">
        Para
        <textarea
          className={clsx(fieldClass, 'mt-1 min-h-16')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-xs font-semibold text-ink-muted">
        Primer párrafo (opcional)
        <textarea
          className={clsx(fieldClass, 'mt-1 min-h-16')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      {!confirming ? (
        <button
          type="button"
          className={clsx(pillPrimary, 'mt-3')}
          disabled={!list.length}
          onClick={() => setConfirming(true)}
        >
          Mandar…
        </button>
      ) : (
        <div
          className="mt-3 rounded-sm border border-amber/40 bg-amber-soft p-3 text-xs text-ink"
          role="alertdialog"
          aria-label="Confirmar el envío"
        >
          <p>
            Vas a mandar el informe de {props.report.content.periodLabel} a{' '}
            <strong>{list.join(', ')}</strong>. ¿Lo mando?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={pillPrimary}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await props.actions.send(props.report.id, list, message.trim() || null);
                  setNote(
                    r.ok ? { ok: true, text: r.note ?? 'Enviado.' } : { ok: false, text: r.error },
                  );
                  setConfirming(false);
                  if (r.ok) router.refresh();
                })
              }
            >
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Sí, mandarlo
            </button>
            <button
              type="button"
              className={pillLink}
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
      <div className="mt-2">
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

function SharePanel(props: BoardDetailProps) {
  const router = useRouter();
  const [visibility, setVisibility] = useState(props.report.visibility);
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(props.publicUrl);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const apply = (rotate = false) =>
    start(async () => {
      const r = await props.actions.setAccess(props.report.id, {
        visibility,
        ...(visibility === 'contrasena' && password ? { password } : {}),
        rotate,
      });
      if (r.ok) {
        setUrl(r.url ?? null);
        setPassword('');
        setNote({ ok: true, text: r.note ?? 'Listo.' });
        router.refresh();
      } else setNote({ ok: false, text: r.error });
    });
  return (
    <Panel className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <Link2 className="h-4 w-4 text-primary" aria-hidden /> Enlace para compartir
      </h2>
      <div className="mt-3 space-y-1.5 text-sm">
        {(
          [
            ['privado', 'Privado: sólo el equipo, con sesión'],
            ['enlace', 'Cualquiera con el enlace'],
            ['contrasena', 'Con el enlace y una contraseña'],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              checked={visibility === v}
              onChange={() => setVisibility(v)}
            />
            {label}
          </label>
        ))}
      </div>
      {visibility === 'contrasena' && (
        <label className="mt-2 block text-xs font-semibold text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" aria-hidden />
            {props.report.visibility === 'contrasena'
              ? 'Nueva contraseña (vacía = la misma)'
              : 'Contraseña (mínimo 6)'}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className={clsx(fieldClass, 'mt-1')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() => apply(false)}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar
        </button>
        {url && (
          <button type="button" className={pillLink} disabled={pending} onClick={() => apply(true)}>
            Cambiar el enlace
          </button>
        )}
      </div>
      {url && (
        <div className="mt-3 flex items-center gap-2 rounded-sm bg-surface-2 px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate text-micro text-ink">{url}</code>
          <button
            type="button"
            aria-label="Copiar el enlace"
            className="text-ink-muted hover:text-ink"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(url)
                .then(() => setNote({ ok: true, text: 'Enlace copiado.' }));
            }}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      {props.report.shareViews > 0 && (
        <p className="mt-2 text-micro text-ink-muted">
          Abierto {props.report.shareViews} {props.report.shareViews === 1 ? 'vez' : 'veces'}.
        </p>
      )}
      <div className="mt-2">
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

function RegeneratePanel(props: BoardDetailProps) {
  const router = useRouter();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <RefreshCw className="h-4 w-4 text-primary" aria-hidden /> Volver a armarlo
      </h2>
      <p className="mt-1 text-micro text-ink-muted">
        Con las cifras de hoy (por ejemplo, después de categorizar el libro). Queda otra vez en
        borrador. Armado el {shortDay(props.report.generatedAt)}.
      </p>
      <button
        type="button"
        className={clsx(pillLink, 'mt-3')}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await props.actions.generate(props.report.period);
            setNote(r.ok ? { ok: true, text: r.note ?? 'Listo.' } : { ok: false, text: r.error });
            if (r.ok) router.refresh();
          })
        }
      >
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        Volver a armarlo
      </button>
      <div className="mt-2">
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}
