'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AccountNeed } from '@/lib/browser-login';
import { originOf } from '@/lib/browser-login';
import { MODULE } from '@/lib/browser-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Pedir la cuenta del portal, en el momento en que alguien sabe la respuesta.
 *
 * ---------------------------------------------------------------------------
 * QUÉ TIENE QUE DECIR ESTA CAJA ANTES DE PEDIR NADA
 * ---------------------------------------------------------------------------
 * Se le está pidiendo a una persona la contraseña de la empresa en un portal
 * del Estado. Eso no es un campo más de un formulario, y tratarlo como si lo
 * fuera es exactamente lo que hace que alguien escriba la clave del gerente en
 * un chat. Así que antes del primer input van tres frases, no cuatro:
 *
 *   1. POR QUÉ hace falta, con el motivo concreto de este trámite — no «por
 *      seguridad», sino «en la grabación hay un campo de contraseña» o «este
 *      portal no se abre sin cuenta».
 *   2. QUÉ SE GUARDA y qué no: los nombres de los campos viajan en claro
 *      porque hay que poder decir qué se guardó; los valores se cifran con la
 *      misma llave que los tokens de OAuth y no hay ninguna ruta en el
 *      producto que los lea de vuelta.
 *   3. QUIÉN PUEDE. El POST es de administradores. Si esta persona no lo es se
 *      lo decimos AQUÍ, con el campo todavía sin dibujar: un formulario que
 *      recibe una contraseña y después contesta «no tienes permiso» ya hizo
 *      que alguien tecleara un secreto para nada, y lo siguiente que hace esa
 *      persona es mandárselo a un administrador por WhatsApp.
 *
 * ---------------------------------------------------------------------------
 * LOS NOMBRES DE CAMPO NO SON DECORACIÓN
 * ---------------------------------------------------------------------------
 * El servicio de navegador resuelve un paso secreto como
 * `secrets[value.field]`. Si el trámite pide «clave» y aquí se guarda
 * «password», el robot teclea una cadena vacía y el portal contesta
 * «credenciales inválidas» — un fallo que parece del portal y es nuestro. Por
 * eso los campos que se piden salen de los pasos (`secretFieldNames`) y no de
 * lo que nos parezca bonito.
 *
 * ---------------------------------------------------------------------------
 * Y CUANDO GUARDARLA NO ALCANZA
 * ---------------------------------------------------------------------------
 * `need.loginNeverTaught` significa que la grabación empezó dentro de la
 * sesión: no hay pasos de ingreso donde escribir esta clave, así que el
 * trámite va a volver a estrellarse contra la misma puerta. La cuenta se
 * guarda igual —va a hacer falta, y queda lista para reusar— pero la caja lo
 * dice sin adornos en vez de dejar a alguien creyendo que quedó resuelto.
 */

/** Un valor que se teclea a ciegas, según cómo se llame el campo. */
const MASKED = ['clave', 'contrasena', 'contraseña', 'password', 'pin', 'token', 'otp', 'secreto'];

function isMasked(field: string): boolean {
  const folded = field
    .normalize('NFD')
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: quitar los diacríticos es la intención
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return MASKED.some((word) => folded.includes(word));
}

/** `codigo_de_verificacion` → «Código de verificación», más o menos. */
function fieldLabel(field: string): string {
  const words = field.replaceAll(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Saved {
  id: string;
  label: string;
  host: string;
  fieldNames: string[];
}

export function AccountForm({
  need,
  startUrl,
  flowName,
  flowId = null,
  onLinked,
  onSkip,
  skipLabel = 'Ahora no',
}: {
  need: AccountNeed;
  /** De dónde sale el sitio al que pertenece la cuenta. */
  startUrl: string;
  flowName: string;
  /** Cuando el trámite ya existe, además de guardarla se la vincula. */
  flowId?: string | null;
  onLinked: (credentialId: string) => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const host = originOf(startUrl) || startUrl;

  const [canSave, setCanSave] = useState<boolean | null>(null);
  const [existing, setExisting] = useState<Saved[]>([]);
  const [label, setLabel] = useState(`${flowName} · ${host.replace(/^https?:\/\//, '')}`);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const response = await fetch('/api/browser/credentials');
      if (!response.ok) {
        if (alive) setCanSave(false);
        return;
      }
      const payload = (await response.json()) as { credentials?: Saved[]; canSave?: boolean };
      if (!alive) return;
      setCanSave(payload.canSave ?? false);
      setExisting(payload.credentials ?? []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Las que ya están guardadas para este mismo sitio: no hay que volver a teclearlas. */
  const reusable = useMemo(
    () => existing.filter((c) => c.host.toLowerCase() === host.toLowerCase()),
    [existing, host],
  );

  const bind = useCallback(
    async (credentialId: string): Promise<boolean> => {
      if (!flowId) return true;
      const response = await fetch('/api/browser/credentials/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowId, credentialId }),
      });
      if (response.ok) return true;
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'La guardé, pero no pude vincularla a este trámite.');
      return false;
    },
    [flowId],
  );

  const useExisting = useCallback(
    async (credential: Saved) => {
      setBusy(true);
      setError(null);
      if (await bind(credential.id)) {
        setDone(credential.label);
        onLinked(credential.id);
      }
      setBusy(false);
    },
    [bind, onLinked],
  );

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);

    // Los valores salen de aquí y no vuelven: se mandan una vez y el estado se
    // limpia en cuanto la respuesta llega, pase lo que pase.
    const fields: Record<string, string> = {};
    for (const field of need.fields) fields[field] = values[field] ?? '';

    const response = await fetch('/api/browser/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label.trim(), host, fields }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      credential?: Saved;
      error?: string;
    };

    if (!response.ok || !payload.credential) {
      // El mensaje viene del servidor y es una frase fija. Nada de lo que se
      // tecleó entra en un error, en un log ni en una traza.
      setError(payload.error ?? 'No pude guardarla. Vuelve a intentarlo.');
      setBusy(false);
      return;
    }

    setValues({});
    if (await bind(payload.credential.id)) {
      setDone(payload.credential.label);
      onLinked(payload.credential.id);
    }
    setBusy(false);
  }, [bind, host, label, need.fields, onLinked, values]);

  if (done) {
    return (
      <div className="rounded-card border border-emerald/20 bg-emerald-soft px-4 py-3">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-emerald">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Cuenta vinculada: «{done}»
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Queda cifrada y sólo se abre para {host}. Nadie —tú tampoco— la vuelve a ver desde Cortex;
          si cambia, se reemplaza.
        </p>
      </div>
    );
  }

  const complete = need.fields.every((field) => (values[field] ?? '').trim().length > 0);

  return (
    <div
      className={clsx(
        'rounded-card border px-4 py-3.5',
        need.certain ? 'border-amber/20 bg-amber-soft/70' : 'border-border bg-surface-2/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-ink" aria-hidden="true" />
        <h4 className="text-sm font-semibold text-ink">{need.title}</h4>
        <span className={chipClass(need.certain ? 'amber' : 'neutral')}>
          {need.certain ? 'le falta la cuenta' : 'seguramente la necesita'}
        </span>
      </div>

      <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-ink-muted">{need.reason}</p>

      {need.loginNeverTaught && (
        <p className="mt-2.5 rounded-sm border border-amber/20 bg-surface px-3 py-2 text-xs leading-relaxed text-ink">
          <AlertTriangle
            className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-amber"
            aria-hidden="true"
          />
          <strong className="font-semibold">Guardar la cuenta aquí no alcanza.</strong> La grabación
          no tiene los pasos del ingreso, así que no hay dónde escribir esta clave: hay que volver a
          enseñar el {MODULE.one} cerrando sesión primero, para que la grabación incluya la entrada
          al portal. Guárdala igual —te va a hacer falta— y elígela de la lista cuando lo enseñes
          otra vez.
        </p>
      )}

      {canSave === null && (
        <p className="mt-3 flex items-center gap-2 text-xs text-ink-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Un momento…
        </p>
      )}

      {/* Antes de cualquier campo. Ver la nota de arriba: decirlo después es
          haber hecho que alguien teclee una contraseña para nada. */}
      {canSave === false && (
        <div className="mt-3 rounded-sm border border-border bg-surface px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Esto lo guarda un administrador
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Una clave de la empresa le da a Cortex el poder de actuar como la empresa en {host}, así
            que quién la guarda es una decisión de administración y no te voy a pedir que la
            escribas aquí. Dile a un administrador del espacio de trabajo que abra este {MODULE.one}{' '}
            y la vincule; los pasos ya quedaron aprendidos.
          </p>
        </div>
      )}

      {canSave === true && (
        <>
          {reusable.length > 0 && (
            <div className="mt-3">
              <p className="field-label">Ya tienes una cuenta guardada de este sitio</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {reusable.map((credential) => (
                  <button
                    key={credential.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void useExisting(credential)}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-all duration-150 hover:-translate-y-px hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transform-none motion-reduce:transition-none"
                  >
                    <KeyRound className="h-3 w-3" aria-hidden="true" />
                    Usar «{credential.label}»
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-ink-faint">
                O guarda una nueva abajo. Reusar la misma evita tener dos claves del mismo portal
                que hay que rotar por separado.
              </p>
            </div>
          )}

          <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="field-label" htmlFor="cred-label">
                Cómo la vas a reconocer
              </label>
              <Input
                id="cred-label"
                className="mt-1.5"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="DIAN — contabilidad"
              />
            </div>
            {need.fields.map((field) => (
              <div key={field}>
                <label className="field-label" htmlFor={`cred-${field}`}>
                  {fieldLabel(field)}
                </label>
                <Input
                  id={`cred-${field}`}
                  className="mt-1.5"
                  type={isMasked(field) ? 'password' : 'text'}
                  // `new-password` a propósito: sin esto el navegador ofrece
                  // guardar la clave de la empresa en el perfil personal de
                  // quien la está tecleando, que es justo el reguero que este
                  // formulario existe para evitar.
                  autoComplete={isMasked(field) ? 'new-password' : 'off'}
                  spellCheck={false}
                  value={values[field] ?? ''}
                  onChange={(e) => setValues({ ...values, [field]: e.target.value })}
                />
              </div>
            ))}
          </div>

          <p className="mt-2.5 flex gap-1.5 text-xs leading-snug text-ink-faint">
            <ShieldCheck
              className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald"
              aria-hidden="true"
            />
            <span>
              Se cifra con la misma llave que los permisos de Google y Microsoft. Cortex no la
              muestra nunca —no hay ninguna pantalla ni respuesta que la devuelva— y sólo la abre
              para {host}: si el {MODULE.one} apunta a otro sitio, se niega a usarla. En las trazas
              aparece como «***».
            </span>
          </p>

          {error && (
            <p className="mt-2.5 text-xs font-medium text-rose" role="alert">
              {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()} disabled={busy || !complete || !label.trim()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Guardar la cuenta
            </Button>
            {onSkip && (
              <Button variant="ghost" onClick={onSkip} disabled={busy}>
                {skipLabel}
              </Button>
            )}
          </div>
        </>
      )}

      {canSave === false && onSkip && (
        <div className="mt-3">
          <Button variant="ghost" onClick={onSkip}>
            {skipLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
