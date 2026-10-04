'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-error-message';
import { secretFromTotpUri } from '@/lib/security/user-agent';
import { Check, Copy, Download, Loader2, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Verificación en dos pasos: activar, mostrar los códigos de respaldo UNA vez,
 * regenerarlos y desactivar.
 *
 * Todo pasa por `authClient.twoFactor.*`: la contraseña se confirma en el
 * servidor de better-auth, el secreto nunca se guarda aquí y los códigos de
 * respaldo sólo existen en esta pantalla mientras está abierta.
 *
 * SIN QR, A PROPÓSITO. No hay una librería de QR en el proyecto y agregar una
 * sólo para esto pesa más que el problema: en el móvil el enlace «Abrir en mi
 * app» abre el autenticador directo, y en el escritorio se teclea la clave que
 * se muestra («Ingresar clave manualmente» en Google Authenticator, Authy,
 * 1Password…). Si más adelante se quiere el QR, se agrega SÓLO en `ScanStep`.
 */

type Step =
  | { kind: 'idle' }
  | { kind: 'password'; action: 'enable' | 'disable' | 'codes' }
  | { kind: 'scan'; totpURI: string; backupCodes: string[] }
  | { kind: 'codes'; backupCodes: string[]; fresh: boolean };

export function TwoFactorPanel({
  enabled,
  hasPassword,
  isFounder,
}: {
  enabled: boolean;
  hasPassword: boolean;
  isFounder: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function go(next: Step) {
    setStep(next);
    setPassword('');
    setCode('');
    setError(null);
  }

  async function confirmPassword() {
    if (step.kind !== 'password') return;
    setBusy(true);
    setError(null);
    try {
      if (step.action === 'enable') {
        const { data, error: failure } = await authClient.twoFactor.enable({ password });
        if (failure || !data) {
          setError(
            authErrorMessage(failure, 'No se pudo iniciar la activación. Revisa tu contraseña.'),
          );
          return;
        }
        go({ kind: 'scan', totpURI: data.totpURI, backupCodes: data.backupCodes });
      } else if (step.action === 'disable') {
        const { error: failure } = await authClient.twoFactor.disable({ password });
        if (failure) {
          setError(authErrorMessage(failure, 'No se pudo desactivar. Revisa tu contraseña.'));
          return;
        }
        go({ kind: 'idle' });
        router.refresh();
      } else {
        const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({
          password,
        });
        if (failure || !data) {
          setError(
            authErrorMessage(failure, 'No se pudieron generar los códigos. Revisa tu contraseña.'),
          );
          return;
        }
        go({ kind: 'codes', backupCodes: data.backupCodes, fresh: false });
      }
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (step.kind !== 'scan') return;
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await authClient.twoFactor.verifyTotp({
        code: code.replace(/\s+/g, ''),
      });
      if (failure) {
        setError(
          authErrorMessage(
            failure,
            'Ese código no fue aceptado. Cambian cada 30 segundos: escribe el actual.',
          ),
        );
        return;
      }
      go({ kind: 'codes', backupCodes: step.backupCodes, fresh: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHead
        title="Verificación en dos pasos"
        icon={enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
        right={
          <span
            className={
              enabled
                ? 'rounded-pill border border-emerald/30 bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald'
                : 'rounded-pill border border-border bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted'
            }
          >
            {enabled ? 'Activa' : 'Sin activar'}
          </span>
        }
      />
      <div className="space-y-4 px-6 pb-6 pt-3 text-sm">
        {!enabled && isFounder && step.kind === 'idle' && (
          <p
            role="note"
            className="rounded-sm border border-amber/30 bg-amber-soft px-3 py-2 text-xs text-ink"
          >
            <strong className="font-semibold">
              Eres fundador: activa la verificación en dos pasos.
            </strong>{' '}
            Tu cuenta puede borrar la empresa y retirar a los demás; con un segundo paso, una
            contraseña filtrada no alcanza para hacerlo.
          </p>
        )}

        {step.kind === 'idle' && (
          <>
            <p className="text-ink-muted">
              {enabled
                ? 'Al entrar te pedimos, además de tu contraseña, un código de 6 dígitos de tu app de autenticación. También se te pide para los cambios de fundadores.'
                : 'Agrega un código de tu teléfono (Google Authenticator, Authy, 1Password…) además de tu contraseña. Es lo que más protege tu cuenta.'}
            </p>
            {!hasPassword ? (
              <p className="rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-ink-muted">
                Tu cuenta entra con Google y no tiene contraseña. Para{' '}
                {enabled ? 'cambiar esto' : 'activar los dos pasos'} primero crea una contraseña en
                «Contraseña», aquí abajo.
              </p>
            ) : enabled ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => go({ kind: 'password', action: 'codes' })}>
                  Generar códigos de respaldo nuevos
                </Button>
                <Button
                  variant="outline"
                  onClick={() => go({ kind: 'password', action: 'disable' })}
                >
                  Desactivar
                </Button>
              </div>
            ) : (
              <Button onClick={() => go({ kind: 'password', action: 'enable' })}>Activar</Button>
            )}
          </>
        )}

        {step.kind === 'password' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmPassword();
            }}
            className="space-y-3"
          >
            <p className="text-ink-muted">
              {step.action === 'enable'
                ? 'Para empezar, confirma tu contraseña.'
                : step.action === 'disable'
                  ? 'Desactivar los dos pasos deja tu cuenta protegida solo por la contraseña. Confírmala para continuar.'
                  : 'Los códigos anteriores dejarán de servir. Confirma tu contraseña para generar nuevos.'}
            </p>
            <Input
              type="password"
              autoComplete="current-password"
              aria-label="Tu contraseña"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="max-w-xs"
              disabled={busy}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || password.length === 0}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Continuar
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => go({ kind: 'idle' })}
                disabled={busy}
              >
                Cancelar
              </Button>
            </div>
          </form>
        )}

        {step.kind === 'scan' && (
          <ScanStep
            totpURI={step.totpURI}
            code={code}
            setCode={setCode}
            busy={busy}
            onVerify={() => void verifyCode()}
            onCancel={() => go({ kind: 'idle' })}
          />
        )}

        {step.kind === 'codes' && (
          <BackupCodes
            codes={step.backupCodes}
            fresh={step.fresh}
            onDone={() => {
              go({ kind: 'idle' });
              router.refresh();
            }}
          />
        )}

        {error && (
          <p
            role="alert"
            className="rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
          >
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-8 px-3 py-1 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Sin permiso de portapapeles: la clave sigue visible para copiarla a mano.
        }
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {copied ? 'Copiado' : label}
    </Button>
  );
}

function ScanStep({
  totpURI,
  code,
  setCode,
  busy,
  onVerify,
  onCancel,
}: {
  totpURI: string;
  code: string;
  setCode: (value: string) => void;
  busy: boolean;
  onVerify: () => void;
  onCancel: () => void;
}) {
  const secret = secretFromTotpUri(totpURI);
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-3 pl-5 text-ink-muted">
        <li>
          Abre tu app de autenticación y agrega una cuenta con clave manual.
          <div className="mt-2 space-y-2 rounded-sm border border-border bg-surface-2 p-3">
            {secret && (
              <div className="flex flex-wrap items-center gap-2">
                <code className="tabular select-all break-all font-mono text-sm tracking-wider text-ink">
                  {secret}
                </code>
                <CopyButton text={secret.replace(/\s+/g, '')} label="Copiar clave" />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={totpURI}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
              >
                <Smartphone className="h-3.5 w-3.5" aria-hidden />
                Abrir en mi app (en el móvil)
              </a>
              <CopyButton text={totpURI} label="Copiar enlace" />
            </div>
          </div>
        </li>
        <li>Escribe aquí el código de 6 dígitos que muestra la app.</li>
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onVerify();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <Input
          aria-label="Código de 6 dígitos"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="tabular w-40 text-center tracking-widest"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !/^\d{6}$/.test(code.replace(/\s+/g, ''))}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Verificar y activar
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </form>
    </div>
  );
}

function BackupCodes({
  codes,
  fresh,
  onDone,
}: {
  codes: string[];
  fresh: boolean;
  onDone: () => void;
}) {
  const text = codes.join('\n');
  const [saved, setSaved] = useState(false);
  function download() {
    const blob = new Blob(
      [`Códigos de respaldo de Cortex\nCada uno sirve una sola vez.\n\n${text}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cortex-codigos-de-respaldo.txt';
    link.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  }
  return (
    <div className="space-y-3">
      {fresh && (
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Listo: la verificación en dos pasos está activa.
        </p>
      )}
      <p className="text-ink-muted">
        Estos son tus códigos de respaldo. Sirven{' '}
        <strong className="font-semibold text-ink">una sola vez cada uno</strong> si pierdes el
        teléfono, y <strong className="font-semibold text-ink">no se vuelven a mostrar</strong>.
        Guárdalos en un lugar seguro.
      </p>
      <ul className="grid max-w-sm grid-cols-2 gap-1.5 rounded-sm border border-border bg-surface-2 p-3 font-mono text-sm text-ink">
        {codes.map((value) => (
          <li key={value} className="tabular select-all">
            {value}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={text} label="Copiar todos" />
        <Button
          type="button"
          variant="outline"
          className="min-h-8 px-3 py-1 text-xs"
          onClick={download}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Descargar
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="accent-primary"
        />
        Ya guardé mis códigos de respaldo
      </label>
      <Button type="button" onClick={onDone} disabled={!saved}>
        Listo
      </Button>
    </div>
  );
}
