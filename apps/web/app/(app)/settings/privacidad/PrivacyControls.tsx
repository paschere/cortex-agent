'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { authClient } from '@/lib/auth-client';
import { confirmsCompanyName } from '@/lib/legal/permissions';
import { LEGAL_RIGHTS, LEGAL_RIGHT_LABEL, type LegalRight, kindForRight } from '@/lib/legal/rights';
import {
  LEGAL_DOCUMENT_PATH,
  LEGAL_DOCUMENT_TITLE,
  type LegalDocument,
} from '@/lib/legal/versions';
import { Download, FileText, MessageSquareText, ShieldCheck, Trash2, UserX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

/**
 * Los controles de «Privacidad y datos». Cada acción llama a su ruta en
 * /api/legal y refresca la página; las reglas de quién puede qué viven en el
 * servidor (las rutas) y aquí sólo deciden qué botones se ven.
 */

export interface ConsentView {
  document: string;
  version: string;
  acceptedAt: string;
  source: string;
  revokedAt: string | null;
  current: boolean;
}

export interface RequestView {
  id: string;
  kind: 'consulta' | 'reclamo';
  right: LegalRight;
  message: string;
  status: string;
  receivedAt: string;
  dueOn: string;
  businessDaysLeft: number;
  response: string | null;
}

export interface ExportView {
  id: string;
  scope: 'empresa' | 'personal';
  status: string;
  sizeBytes: number | null;
  createdAt: string;
  expiresAt: string | null;
  error: string | null;
  mine: boolean;
}

export interface DeletionView {
  status: string;
  requestedAt: string;
  purgeAfter: string;
  requestedBy: string;
}

const STATUS_LABEL: Record<string, string> = {
  pendiente: 'En cola',
  generando: 'Generando…',
  lista: 'Lista',
  fallida: 'Falló',
  vencida: 'Vencida',
  recibida: 'Recibida',
  en_tramite: 'En trámite',
  prorrogada: 'Prorrogada',
  respondida: 'Respondida',
  cerrada: 'Cerrada',
};

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function size(n: number | null): string {
  if (!n) return '';
  return n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
}

async function call(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: data?.error ?? 'Algo falló. Inténtalo de nuevo.' };
}

function Section({
  id,
  icon,
  title,
  blurb,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{blurb}</p>
        </div>
      </div>
      <Panel className="p-5">{children}</Panel>
    </section>
  );
}

function LoadFailed() {
  return (
    <p className="text-sm text-ink-muted">No se pudo cargar esta sección. Recarga la página.</p>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-rose">
      {text}
    </p>
  );
}

export function PrivacyControls(props: {
  email: string;
  organizationName: string;
  canExportCompany: boolean;
  canDeleteCompany: boolean;
  consents: ConsentView[] | null;
  requests: RequestView[] | null;
  exports: ExportView[] | null;
  deletion: DeletionView | null;
  deletionLoadFailed: boolean;
  accountPreview: { blockers: string[]; solo: string[]; shared: string[] } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string | null>>({});

  async function run(
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    after?: () => void,
  ) {
    setBusy(key);
    setErr((e) => ({ ...e, [key]: null }));
    const r = await fn().catch(() => ({
      ok: false,
      error: 'No hubo conexión. Inténtalo de nuevo.',
    }));
    setBusy(null);
    if (!r.ok) {
      setErr((e) => ({ ...e, [key]: r.error ?? 'Algo falló.' }));
      return;
    }
    if (after) after();
    else router.refresh();
  }

  return (
    <div className="max-w-3xl space-y-10">
      <DownloadSection {...props} busy={busy} err={err} run={run} />
      <RequestsSection requests={props.requests} busy={busy} err={err} run={run} />
      <ConsentSection consents={props.consents} busy={busy} err={err} run={run} />
      <DeleteUserSection {...props} busy={busy} err={err} run={run} />
      {props.canDeleteCompany && (
        <DeleteCompanySection {...props} busy={busy} err={err} run={run} />
      )}
      <p className="text-xs leading-relaxed text-ink-faint">
        Documentos:{' '}
        {(['tratamiento', 'privacidad', 'terminos'] as LegalDocument[]).map((d) => (
          <a
            key={d}
            href={LEGAL_DOCUMENT_PATH[d]}
            target="_blank"
            rel="noreferrer"
            className="mr-3 hover:underline"
          >
            {LEGAL_DOCUMENT_TITLE[d]}
          </a>
        ))}
        <a href="/cookies" target="_blank" rel="noreferrer" className="hover:underline">
          Aviso de cookies
        </a>
      </p>
    </div>
  );
}

type Runner = {
  busy: string | null;
  err: Record<string, string | null>;
  run: (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    after?: () => void,
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
function DownloadSection({
  exports,
  canExportCompany,
  busy,
  err,
  run,
}: Runner & { exports: ExportView[] | null; canExportCompany: boolean }) {
  const pending = exports?.some((e) => e.status === 'pendiente' || e.status === 'generando');
  return (
    <Section
      id="exportar"
      icon={<Download className="h-4 w-4" />}
      title="Descargar datos"
      blurb="Un archivo ZIP con tus datos, o con todos los de la empresa. Se arma en segundo plano y te avisamos cuando esté listo; el enlace dura 7 días y pide iniciar sesión."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run('export', () => call('/api/legal/exports', 'POST', { scope: 'personal' }))
          }
        >
          Descargar mis datos
        </Button>
        {canExportCompany && (
          <Button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run('export', () => call('/api/legal/exports', 'POST', { scope: 'empresa' }))
            }
          >
            Descargar todos los datos de la empresa
          </Button>
        )}
      </div>
      <ErrorLine text={err.export ?? null} />
      {pending && (
        <p className="mt-3 text-xs text-ink-muted">
          Hay una exportación en curso. Puede tardar unos minutos; te llegará un aviso y un correo.
        </p>
      )}
      {exports === null ? (
        <div className="mt-4">
          <LoadFailed />
        </div>
      ) : exports.length > 0 ? (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {exports.map((e) => {
            const live =
              e.status === 'lista' && e.expiresAt && Date.parse(e.expiresAt) > Date.now();
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <span className="text-ink">
                  {e.scope === 'empresa' ? 'Toda la empresa' : 'Mis datos'}
                  <span className="ml-2 text-xs text-ink-faint">
                    {day(e.createdAt)} · {STATUS_LABEL[e.status] ?? e.status}
                    {e.sizeBytes ? ` · ${size(e.sizeBytes)}` : ''}
                    {live && e.expiresAt ? ` · hasta el ${day(e.expiresAt)}` : ''}
                  </span>
                </span>
                {live && (e.scope === 'empresa' ? canExportCompany : e.mine) && (
                  <a
                    href={`/api/legal/exports/${e.id}/download`}
                    className="text-sm font-semibold text-primary hover:underline"
                  >
                    Descargar ZIP
                  </a>
                )}
                {e.status === 'fallida' && e.error && (
                  <span className="text-xs text-rose">{e.error}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
function RequestsSection({
  requests,
  busy,
  err,
  run,
}: Runner & { requests: RequestView[] | null }) {
  const [right, setRight] = useState<LegalRight>('conocer');
  const [message, setMessage] = useState('');
  const kind = kindForRight(right);
  return (
    <Section
      id="solicitudes"
      icon={<MessageSquareText className="h-4 w-4" />}
      title="Consultas y reclamos"
      blurb="Pregunta qué datos tuyos tenemos, pide corregirlos o suprimirlos, o reclama. La ley nos da 10 días hábiles para una consulta y 15 para un reclamo."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            'request',
            () => call('/api/legal/requests', 'POST', { right, message }),
            () => {
              setMessage('');
              window.location.reload();
            },
          );
        }}
      >
        <label className="block">
          <span className="field-label">Qué quieres hacer</span>
          <select
            className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={right}
            onChange={(e) => setRight(e.target.value as LegalRight)}
          >
            {LEGAL_RIGHTS.map((r) => (
              <option key={r} value={r}>
                {LEGAL_RIGHT_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Cuéntanos</span>
          <textarea
            className="mt-1 min-h-24 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={message}
            minLength={10}
            maxLength={5000}
            required
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe tu solicitud. Si es un reclamo, incluye los hechos y lo que quieres que hagamos."
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-ink-muted">
            Se radica como <strong>{kind}</strong>: respuesta en máximo{' '}
            {kind === 'consulta' ? '10' : '15'} días hábiles.
          </span>
          <Button type="submit" disabled={busy !== null || message.trim().length < 10}>
            Enviar
          </Button>
        </div>
      </form>
      <ErrorLine text={err.request ?? null} />
      {requests === null ? (
        <div className="mt-4">
          <LoadFailed />
        </div>
      ) : requests.length > 0 ? (
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {requests.map((r) => (
            <li key={r.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">
                  {LEGAL_RIGHT_LABEL[r.right]}{' '}
                  <span className="font-mono text-xs font-normal text-ink-faint">
                    {r.id.slice(0, 8).toUpperCase()}
                  </span>
                </span>
                <span className="text-xs text-ink-muted">
                  {STATUS_LABEL[r.status] ?? r.status} · radicada el {day(r.receivedAt)} · vence{' '}
                  {day(`${r.dueOn}T12:00:00`)}
                  {r.status !== 'respondida' && r.status !== 'cerrada'
                    ? r.businessDaysLeft >= 0
                      ? ` (${r.businessDaysLeft} días hábiles)`
                      : ' (vencida)'
                    : ''}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{r.message}</p>
              {r.response && <p className="mt-1 text-xs text-ink">Respuesta: {r.response}</p>}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
function ConsentSection({ consents, busy, err, run }: Runner & { consents: ConsentView[] | null }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Section
      id="autorizaciones"
      icon={<FileText className="h-4 w-4" />}
      title="Tus autorizaciones"
      blurb="Qué aceptaste, cuándo y en qué versión. Puedes revocar la autorización de tratamiento; sin ella no podemos prestarte el servicio, así que se te volverá a pedir al entrar."
    >
      {consents === null ? (
        <LoadFailed />
      ) : consents.length === 0 ? (
        <p className="text-sm text-ink-muted">Todavía no hay autorizaciones registradas.</p>
      ) : (
        <ul className="divide-y divide-border">
          {consents.map((c) => (
            <li
              key={`${c.document}-${c.version}`}
              className="flex flex-wrap justify-between gap-2 py-2 text-sm"
            >
              <span className="text-ink">
                {LEGAL_DOCUMENT_TITLE[c.document as LegalDocument] ?? c.document}{' '}
                <span className="text-xs text-ink-faint">versión {c.version}</span>
              </span>
              <span className="text-xs text-ink-muted">
                {c.revokedAt
                  ? `Revocada el ${day(c.revokedAt)}`
                  : `Aceptada el ${day(c.acceptedAt)} (${c.source === 'registro' ? 'al registrarte' : 'en la aplicación'})`}
                {!c.current && !c.revokedAt ? ' · versión anterior' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {!confirming ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirming(true)}
            disabled={busy !== null}
          >
            Revocar mi autorización
          </Button>
        ) : (
          <>
            <span className="self-center text-xs text-ink-muted">
              ¿Seguro? Te pediremos aceptarla otra vez para seguir usando Cortex.
            </span>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              No
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy !== null}
              onClick={() => run('consent', () => call('/api/legal/consent', 'DELETE'))}
            >
              Sí, revocar
            </Button>
          </>
        )}
      </div>
      <ErrorLine text={err.consent ?? null} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
function DeleteUserSection({
  email,
  accountPreview,
  busy,
  err,
  run,
}: Runner & {
  email: string;
  accountPreview: { blockers: string[]; solo: string[]; shared: string[] } | null;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const blocked = (accountPreview?.blockers.length ?? 0) > 0;
  return (
    <Section
      id="eliminar-usuario"
      icon={<UserX className="h-4 w-4" />}
      title="Eliminar mi usuario"
      blurb="Borra tu cuenta de Cortex. Lo que creaste dentro de una empresa (documentos, registros, conversaciones compartidas) es de la empresa y se queda; tu nombre y correo dejan de aparecer."
    >
      {accountPreview === null ? (
        <LoadFailed />
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>
            Revocamos tus conexiones con Google y borramos tus credenciales, memorias y
            preferencias.
          </li>
          {accountPreview.solo.length > 0 && (
            <li>
              Se borran por completo, porque sólo estás tú:{' '}
              <strong className="text-ink">{accountPreview.solo.join(', ')}</strong>.
            </li>
          )}
          {accountPreview.shared.length > 0 && (
            <li>
              Sales de: <strong className="text-ink">{accountPreview.shared.join(', ')}</strong>.
            </li>
          )}
          {blocked && (
            <li className="text-rose">
              Eres la única persona dueña de {accountPreview.blockers.join(', ')}. Nombra a otra
              persona como dueña o elimina la empresa antes de borrar tu usuario.
            </li>
          )}
        </ul>
      )}
      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={busy !== null || blocked || accountPreview === null}
          onClick={() => setOpen(true)}
        >
          Eliminar mi usuario…
        </Button>
      ) : (
        <div className="mt-4 space-y-2 rounded-card border border-rose/40 bg-rose-soft/40 p-4">
          <p className="text-sm text-ink">
            Esto no se puede deshacer. Escribe tu correo <span className="font-mono">{email}</span>{' '}
            para confirmar.
          </p>
          <input
            className="w-full rounded-card border border-border bg-surface px-3 py-2 font-mono text-sm text-ink"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            aria-label="Tu correo, para confirmar"
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy !== null || typed.trim().toLowerCase() !== email.trim().toLowerCase()}
              onClick={() =>
                run(
                  'user',
                  () => call('/api/legal/account', 'DELETE', { confirmEmail: typed }),
                  () => {
                    void authClient.signOut().catch(() => null);
                    window.location.href = '/';
                  },
                )
              }
            >
              <Trash2 className="h-4 w-4" /> Eliminar mi usuario
            </Button>
          </div>
        </div>
      )}
      <ErrorLine text={err.user ?? null} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
function DeleteCompanySection({
  organizationName,
  deletion,
  deletionLoadFailed,
  busy,
  err,
  run,
}: Runner & {
  organizationName: string;
  deletion: DeletionView | null;
  deletionLoadFailed: boolean;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState('');

  return (
    <Section
      id="eliminar-empresa"
      icon={<ShieldCheck className="h-4 w-4" />}
      title="Eliminar la cuenta de la empresa"
      blurb="Sólo el dueño. Borra todo lo de la empresa en Cortex: datos, archivos, conexiones y membresías. Hay 30 días para arrepentirse; después es definitivo."
    >
      {deletionLoadFailed ? (
        <LoadFailed />
      ) : deletion ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            {deletion.status === 'purgando' ? (
              <>El borrado de {organizationName} está en curso.</>
            ) : (
              <>
                El borrado de <strong>{organizationName}</strong> está programado para el{' '}
                <strong>{day(deletion.purgeAfter)}</strong> (lo pidió {deletion.requestedBy} el{' '}
                {day(deletion.requestedAt)}). Hasta entonces todo sigue funcionando y puedes
                cancelarlo.
              </>
            )}
          </p>
          {deletion.status === 'programada' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run('company', () => call('/api/legal/organization-deletion', 'DELETE'))
              }
            >
              Cancelar el borrado
            </Button>
          )}
        </div>
      ) : step === 0 ? (
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setStep(1)}>
          Eliminar la cuenta de la empresa…
        </Button>
      ) : step === 1 ? (
        <div className="space-y-3 rounded-card border border-rose/40 bg-rose-soft/40 p-4 text-sm text-ink">
          <p>
            Antes de seguir, descarga todos los datos de la empresa si quieres conservar una copia.
            Al terminar la gracia de 30 días se borran para todo el equipo y no se pueden recuperar
            (las copias de seguridad los guardan hasta 14 días más y luego desaparecen).
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>
              Entiendo que se borrará toda la información de {organizationName} para todo el equipo.
            </span>
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(0)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={!understood}
              onClick={() => setStep(2)}
            >
              Continuar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-card border border-rose/40 bg-rose-soft/40 p-4">
          <p className="text-sm text-ink">
            Escribe el nombre de la empresa, <strong>{organizationName}</strong>, para confirmar.
          </p>
          <input
            className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            aria-label="Nombre de la empresa, para confirmar"
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(0)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy !== null || !confirmsCompanyName(typed, organizationName)}
              onClick={() =>
                run(
                  'company',
                  () => call('/api/legal/organization-deletion', 'POST', { confirmName: typed }),
                  () => {
                    setStep(0);
                    setTyped('');
                    window.location.reload();
                  },
                )
              }
            >
              <Trash2 className="h-4 w-4" /> Programar el borrado
            </Button>
          </div>
        </div>
      )}
      <ErrorLine text={err.company ?? null} />
    </Section>
  );
}
