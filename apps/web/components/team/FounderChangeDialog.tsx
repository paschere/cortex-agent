'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmationMatches } from '@/lib/founder-rules';
import { founderOnlyCapabilities, sharedWithAdmins } from '@/lib/team/role-matrix';
import { STEP_UP_COPY, type StepUpRequirement } from '@/lib/team/step-up-rules';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, KeyRound, Loader2, ShieldAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';

/**
 * UN SOLO DIÁLOGO PARA LOS CUATRO MOVIMIENTOS DE PROPIEDAD.
 *
 * Hacer cofundador, pasar la propiedad, dejar de ser fundador y dejar la
 * empresa comparten la misma forma —explicar con precisión qué cambia, pedir
 * que se escriba un nombre, pedir la prueba de identidad— y sólo se diferencian
 * en el texto. Cuatro diálogos copiados se separarían el día que alguien afine
 * uno, y éste es el lugar donde la gente decide lo más difícil de deshacer.
 *
 * Lo que el diálogo NO decide: si se puede. Eso lo repite el servidor
 * (founder-actions.ts) con las reglas de founder-rules.ts; aquí sólo se
 * pinta lo que contesta. El factor que se pide (`requirement`) viene del
 * servidor al pintar la página, y el servidor lo vuelve a calcular al recibir
 * la acción: si cambió entretanto, la respuesta trae el correcto.
 */

export type FounderChangeMode = 'promote' | 'transfer' | 'step_down' | 'leave';

export interface FounderChangePayload {
  confirmation: string;
  password?: string;
  code?: string;
  stepDown?: boolean;
}

export interface FounderChangeResult {
  ok: boolean;
  message?: string;
  error?: string;
  requirement?: string;
}

const TITLE: Record<FounderChangeMode, (person: string) => string> = {
  promote: (person) => `Hacer cofundador a ${person}`,
  transfer: (person) => `Pasar la propiedad a ${person}`,
  step_down: () => 'Dejar de ser fundador',
  leave: () => 'Dejar la empresa',
};

const SUBMIT: Record<FounderChangeMode, string> = {
  promote: 'Hacer cofundador',
  transfer: 'Pasar la propiedad',
  step_down: 'Dejar de ser fundador',
  leave: 'Dejar la empresa',
};

export function FounderChangeDialog({
  mode,
  open,
  onOpenChange,
  companyName,
  personName,
  personEmail,
  requirement,
  hasTwoFactor,
  onSubmit,
  onDone,
}: {
  mode: FounderChangeMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  /** La otra persona (promover y transferir). */
  personName?: string;
  personEmail?: string;
  /** Qué factor se pide; `null` cuando este movimiento no pide ninguno. */
  requirement: StepUpRequirement | null;
  hasTwoFactor: boolean;
  onSubmit: (payload: FounderChangePayload) => Promise<FounderChangeResult>;
  onDone?: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stepDown, setStepDown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // El servidor puede contestar que le toca otro factor; se pinta ése.
  const [demanded, setDemanded] = useState<StepUpRequirement | null>(null);
  const ids = useId();
  const person = personName?.trim() || personEmail || 'esta persona';
  const factor = demanded ?? requirement;
  const accepted = [personName ?? null, personEmail ?? null, companyName];
  const typedOk = confirmationMatches(
    typed,
    mode === 'promote' || mode === 'transfer' ? accepted : [companyName],
  );
  const credentialOk =
    factor === 'totp'
      ? /^\d{6}$/.test(code.replace(/\s+/g, ''))
      : factor === 'password'
        ? password.length > 0
        : factor !== 'sign_in_again';
  const canSubmit = typedOk && credentialOk && !busy;

  function reset() {
    setTyped('');
    setPassword('');
    setCode('');
    setError(null);
    setDemanded(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit({
        confirmation: typed,
        password: factor === 'password' ? password : undefined,
        code: factor === 'totp' ? code : undefined,
        stepDown: mode === 'transfer' ? stepDown : undefined,
      });
      if (!result.ok) {
        setError(result.error ?? result.message ?? 'No se pudo hacer el cambio.');
        if (
          result.requirement === 'totp' ||
          result.requirement === 'password' ||
          result.requirement === 'fresh_session' ||
          result.requirement === 'sign_in_again'
        ) {
          setDemanded(result.requirement);
        }
        // La credencial no se reutiliza: un código ya probado no vuelve a servir.
        setCode('');
        setPassword('');
        return;
      }
      onOpenChange(false);
      reset();
      onDone?.();
    } catch {
      setError('No se pudo hacer el cambio. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(560px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-amber/30 bg-amber-soft text-amber">
                <ShieldAlert className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-bold text-ink">
                  {TITLE[mode](person)}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-ink-muted">
                  {companyName}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="rounded-sm p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
            <Explanation mode={mode} person={person} companyName={companyName} />

            {mode === 'transfer' && (
              <label className="flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={stepDown}
                  onChange={(event) => setStepDown(event.target.checked)}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  <strong className="font-semibold">Dejar de ser fundador yo.</strong> Quedo como
                  administrador. Si no lo marcas, los dos son fundadores.
                </span>
              </label>
            )}

            <div>
              <label htmlFor={`${ids}-confirm`} className="field-label">
                {mode === 'promote' || mode === 'transfer'
                  ? `Para confirmar, escribe «${person}» o «${companyName}»`
                  : `Para confirmar, escribe «${companyName}»`}
              </label>
              <Input
                id={`${ids}-confirm`}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                className="mt-1"
                disabled={busy}
              />
            </div>

            {factor && (
              <div className="rounded-sm border border-border bg-surface-2 px-3 py-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                  <KeyRound className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  Confirma que eres tú
                </div>
                <p className="mt-1 text-xs text-ink-muted">{STEP_UP_COPY[factor]}</p>
                {factor === 'totp' && (
                  <Input
                    aria-label="Código de 6 dígitos"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className="tabular mt-2 text-center tracking-widest"
                    disabled={busy}
                  />
                )}
                {factor === 'password' && (
                  <Input
                    aria-label="Tu contraseña"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="mt-2"
                    disabled={busy}
                  />
                )}
                {!hasTwoFactor && factor !== 'totp' && (
                  <p className="mt-2 text-xs text-ink-muted">
                    Para algo tan importante conviene un segundo paso.{' '}
                    <Link
                      href="/settings/seguridad"
                      className="font-semibold text-primary hover:underline"
                    >
                      Activa la verificación en dos pasos
                    </Link>
                    .
                  </p>
                )}
              </div>
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

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancelar
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              variant={mode === 'leave' ? 'danger' : 'default'}
              onClick={submit}
              disabled={!canSubmit}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {SUBMIT[mode]}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Explanation({
  mode,
  person,
  companyName,
}: {
  mode: FounderChangeMode;
  person: string;
  companyName: string;
}) {
  if (mode === 'promote' || mode === 'transfer') {
    return (
      <div className="space-y-3">
        <p className="text-ink">
          {mode === 'promote' ? (
            <>
              <strong className="font-semibold">{person}</strong> será dueño de{' '}
              <strong className="font-semibold">{companyName}</strong> igual que tú. Un cofundador
              puede hacer todo lo que hace un administrador y, además:
            </>
          ) : (
            <>
              <strong className="font-semibold">{person}</strong> pasará a ser fundador de{' '}
              <strong className="font-semibold">{companyName}</strong>, con todo lo que eso trae:
            </>
          )}
        </p>
        <ul className="space-y-1.5">
          {founderOnlyCapabilities().map((capability) => (
            <li key={capability.id} className="flex items-start gap-2 text-xs text-ink">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span>
                <strong className="font-semibold">{capability.label}.</strong>{' '}
                {capability.hint ? <span className="text-ink-muted">{capability.hint}</span> : null}
              </span>
            </li>
          ))}
          <li className="flex items-start gap-2 text-xs text-ink">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span>
              <strong className="font-semibold">Retirarte a ti también</strong>{' '}
              <span className="text-ink-muted">
                (siempre queda al menos un fundador, pero puede ser otro).
              </span>
            </span>
          </li>
        </ul>
        <p className="text-xs text-ink-muted">
          Lo que ya hace un administrador:{' '}
          {sharedWithAdmins()
            .map((capability) => capability.label.toLowerCase())
            .join('; ')}
          .
        </p>
        <p className="rounded-sm border border-amber/30 bg-amber-soft px-3 py-2 text-xs text-ink">
          Dale este acceso solo a alguien de plena confianza. Avisamos por correo a todos los
          fundadores y queda en la auditoría.
        </p>
      </div>
    );
  }
  if (mode === 'step_down') {
    return (
      <div className="space-y-2">
        <p className="text-ink">
          Dejarás de ser fundador de <strong className="font-semibold">{companyName}</strong> y
          quedarás como administrador: seguirás manejando personas, fuentes y plan, pero ya no
          podrás nombrar o retirar fundadores ni borrar la empresa.
        </p>
        <p className="text-xs text-ink-muted">
          Solo es posible porque queda otro fundador. Si quieres volver a serlo, otro fundador tiene
          que nombrarte.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-ink">
        Saldrás de <strong className="font-semibold">{companyName}</strong>. Perderás el acceso, se
        pausarán tus rutinas en esta empresa y se revocarán las credenciales privadas que guardaste
        en ella.
      </p>
      <p className="text-xs text-ink-muted">
        Lo que hiciste en la empresa se conserva en su historial. Tus otros espacios no cambian.
        Para volver, alguien tiene que invitarte de nuevo.
      </p>
    </div>
  );
}
