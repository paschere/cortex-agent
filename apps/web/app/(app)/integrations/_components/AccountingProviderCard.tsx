'use client';

import { IconTile } from '@/components/sources/visuals';
import { Button } from '@/components/ui/button';
import {
  type AccountingCardData,
  type CardTone,
  ENTITY_LABELS,
  INTERVAL_OPTIONS,
} from '@/lib/accounting/card';
import type { AccountingEntity } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Calculator } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  type AccountingActionResult,
  connectAccountingProgram,
  disconnectAccountingProgram,
  saveAccountingProgramSettings,
  syncAccountingProgramNow,
} from '../accounting-actions';

/**
 * Una tarjeta de «Programas contables»: conectar (la llave se prueba antes de
 * guardarse), ver cómo va, sincronizar ya, cambiar qué se trae y desconectar.
 * La llave se escribe aquí y viaja una sola vez al servidor; nunca vuelve.
 *
 * QuickBooks (`connect: 'oauth'`) no tiene llave que pegar: el botón lleva a
 * Intuit con lo elegido (qué traer, cada cuánto) y la vuelta guarda el
 * permiso. Si la instalación no tiene la app de Intuit configurada, la
 * tarjeta lo dice y el botón queda apagado.
 */

const FIELD =
  'mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary disabled:opacity-50';

const TONE: Record<CardTone, { pill: string; label: string }> = {
  ok: { pill: 'bg-emerald-soft text-emerald', label: 'Al día' },
  working: { pill: 'bg-primary-soft text-primary', label: 'Trayendo datos' },
  error: { pill: 'bg-rose-soft text-rose', label: 'Con error' },
  paused: { pill: 'bg-surface-2 text-ink-muted', label: 'En pausa' },
  idle: { pill: 'bg-surface-2 text-ink-muted', label: 'Sin conectar' },
};

function entityLabel(card: AccountingCardData, entity: AccountingEntity): string {
  return entity === 'payments' ? card.provider.paymentsLabel : ENTITY_LABELS[entity];
}

function EntityPicker({
  card,
  value,
  onChange,
  disabled,
}: {
  card: AccountingCardData;
  value: AccountingEntity[];
  onChange: (next: AccountingEntity[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="mt-3">
      <legend className="text-xs font-semibold text-ink">Qué traer</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {card.provider.entities.map((entity) => {
          const on = value.includes(entity);
          return (
            <button
              key={entity}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((e) => e !== entity) : [...value, entity])}
              className={clsx(
                'rounded-pill border px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50',
                on
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border bg-surface text-ink-muted hover:bg-surface-2',
              )}
            >
              {entityLabel(card, entity)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function ScheduleFields({
  intervalMinutes,
  setIntervalMinutes,
  notify,
  setNotify,
  disabled,
}: {
  intervalMinutes: number;
  setIntervalMinutes: (n: number) => void;
  notify: boolean;
  setNotify: (b: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="block text-xs font-semibold text-ink">
        Cada cuánto
        <select
          className={FIELD}
          value={intervalMinutes}
          disabled={disabled}
          onChange={(e) => setIntervalMinutes(Number(e.target.value))}
        >
          {INTERVAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={notify}
          disabled={disabled}
          onChange={(e) => setNotify(e.target.checked)}
        />
        Avisarme cuando entren facturas o pagos nuevos
      </label>
    </div>
  );
}

export function AccountingProviderCard({ card }: { card: AccountingCardData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<'view' | 'connect' | 'settings' | 'confirm-disconnect'>(
    card.connected ? 'view' : 'connect',
  );
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [entities, setEntities] = useState<AccountingEntity[]>(card.entities);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(card.intervalMinutes);
  const [notify, setNotify] = useState<boolean>(card.notify);
  const [enabled, setEnabled] = useState<boolean>(card.enabled);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const tone = TONE[card.tone];
  const name = card.provider.name;

  function run(action: () => Promise<AccountingActionResult>, after?: () => void) {
    setMessage(null);
    start(async () => {
      const result = await action();
      if (result.ok) {
        setMessage(result.note ? { ok: true, text: result.note } : null);
        setCredentials({});
        after?.();
        router.refresh();
      } else setMessage({ ok: false, text: result.error });
    });
  }

  if (!card.provider.available)
    return (
      <div className="flex h-full flex-col gap-2 rounded-card border border-dashed border-border-strong bg-surface/60 p-4">
        <div className="flex items-center gap-3">
          <IconTile icon={Calculator} tone="neutral" />
          <span className="min-w-0 flex-1 text-sm font-extrabold text-ink">{name}</span>
          <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted">
            Próximamente
          </span>
        </div>
        <p className="text-xs leading-snug text-ink-muted">{card.provider.credentialsHelp}</p>
      </div>
    );

  const oauth = card.provider.connect === 'oauth';
  const setupMissing = card.provider.setupMissing;
  const credentialsReady = card.provider.credentialFields.every(
    (f) => (credentials[f.key] ?? '').trim().length >= 3,
  );

  /** OAuth: a Intuit (o al programa) con lo elegido; la vuelta conecta. */
  function startOauth() {
    if (setupMissing || !entities.length) return;
    setMessage(null);
    setRedirecting(true);
    const params = new URLSearchParams({
      entities: entities.join(','),
      interval: String(intervalMinutes),
      notify: notify ? '1' : '0',
    });
    window.location.assign(`/api/integrations/${card.provider.id}?${params}`);
  }

  return (
    <div className="flex h-full flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <IconTile icon={Calculator} tone="amber" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-extrabold text-ink">{name}</div>
          {card.accountLabel ? (
            <div className="mt-0.5 truncate text-xs text-ink-muted">
              Cuenta: {card.accountLabel}
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-ink-muted">Programa contable</div>
          )}
        </div>
        <span
          className={clsx('shrink-0 rounded-pill px-2.5 py-0.5 text-micro font-bold', tone.pill)}
        >
          {tone.label}
        </span>
      </div>

      {card.connected && <p className="text-xs leading-snug text-ink-muted">{card.status}</p>}

      {card.error && (
        <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs leading-relaxed text-ink">
          {card.error}
        </p>
      )}

      {card.connected && mode === 'view' && card.lines.length > 0 && (
        <ul className="space-y-1.5 border-t border-border pt-3">
          {card.lines.map((line) => (
            <li key={line.entity} className="text-xs leading-snug">
              {line.href ? (
                <Link href={line.href} className="font-semibold text-primary hover:underline">
                  {line.label}
                </Link>
              ) : (
                <span className="font-semibold text-ink">{line.label}</span>
              )}
              <span className="text-ink-muted"> · {line.text}</span>
            </li>
          ))}
        </ul>
      )}
      {card.connected && mode === 'view' && card.purchaseStatus && (
        <p className="text-xs leading-snug text-ink-muted">{card.purchaseStatus}</p>
      )}

      {mode === 'connect' && oauth && (
        <form
          className="border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            startOauth();
          }}
        >
          <p className="text-xs leading-snug text-ink-muted">{card.provider.credentialsHelp}</p>
          {setupMissing && (
            <p className="mt-3 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-xs text-amber">
              {setupMissing}
            </p>
          )}
          <EntityPicker
            card={card}
            value={entities}
            onChange={setEntities}
            disabled={redirecting || Boolean(setupMissing)}
          />
          <ScheduleFields
            intervalMinutes={intervalMinutes}
            setIntervalMinutes={setIntervalMinutes}
            notify={notify}
            setNotify={setNotify}
            disabled={redirecting || Boolean(setupMissing)}
          />
          <p className="mt-3 text-micro leading-snug text-ink-faint">
            Te llevamos a {name} para que des permiso de sólo lectura y vuelves aquí. El permiso
            queda cifrado; nadie lo vuelve a ver, ni siquiera Cortex en el chat.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={redirecting || Boolean(setupMissing) || !entities.length}
            >
              {redirecting ? 'Abriendo…' : `Conectar con ${name}`}
            </Button>
            {card.connected && (
              <Button
                type="button"
                variant="ghost"
                disabled={redirecting}
                onClick={() => setMode('view')}
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}

      {mode === 'connect' && !oauth && (
        <form
          className="border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!credentialsReady || !entities.length) return;
            run(
              () =>
                connectAccountingProgram({
                  provider: card.provider.id,
                  credentials,
                  entities,
                  intervalMinutes,
                  notify,
                }),
              () => setMode('view'),
            );
          }}
        >
          <p className="text-xs leading-snug text-ink-muted">{card.provider.credentialsHelp}</p>
          {card.provider.credentialFields.map((field) => (
            <label key={field.key} className="mt-3 block text-xs font-semibold text-ink">
              {field.label}
              <input
                className={FIELD}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={credentials[field.key] ?? ''}
                disabled={pending}
                onChange={(e) => setCredentials({ ...credentials, [field.key]: e.target.value })}
              />
            </label>
          ))}
          <EntityPicker card={card} value={entities} onChange={setEntities} disabled={pending} />
          <ScheduleFields
            intervalMinutes={intervalMinutes}
            setIntervalMinutes={setIntervalMinutes}
            notify={notify}
            setNotify={setNotify}
            disabled={pending}
          />
          <p className="mt-3 text-micro leading-snug text-ink-faint">
            La llave se prueba con {name} antes de guardarse y queda cifrada. Nadie la vuelve a ver,
            ni siquiera Cortex en el chat.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !credentialsReady || !entities.length}>
              {pending ? 'Probando…' : 'Probar y conectar'}
            </Button>
            {card.connected && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setMode('view')}
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}

      {mode === 'settings' && (
        <form
          className="border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!entities.length) return;
            run(
              () =>
                saveAccountingProgramSettings({
                  provider: card.provider.id,
                  entities,
                  intervalMinutes,
                  notify,
                  enabled,
                }),
              () => setMode('view'),
            );
          }}
        >
          <EntityPicker card={card} value={entities} onChange={setEntities} disabled={pending} />
          <ScheduleFields
            intervalMinutes={intervalMinutes}
            setIntervalMinutes={setIntervalMinutes}
            notify={notify}
            setNotify={setNotify}
            disabled={pending}
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={!enabled}
              disabled={pending}
              onChange={(e) => setEnabled(!e.target.checked)}
            />
            Pausar la sincronización
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !entities.length}>
              {pending ? 'Guardando…' : 'Guardar'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setMode('view')}
            >
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {mode === 'confirm-disconnect' && (
        <div className="rounded-card border border-rose/30 bg-rose-soft p-3 text-xs text-rose">
          <p>
            ¿Desconectar {name}? Se borra la llave y deja de traer datos. Las tablas, la cartera y
            los pagos que ya se trajeron se quedan.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() =>
                run(
                  () => disconnectAccountingProgram({ provider: card.provider.id }),
                  () => setMode('connect'),
                )
              }
            >
              {pending ? 'Desconectando…' : 'Sí, desconectar'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setMode('view')}
            >
              No
            </Button>
          </div>
        </div>
      )}

      {card.connected && mode === 'view' && (
        <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            type="button"
            disabled={pending || !card.enabled}
            onClick={() => run(() => syncAccountingProgramNow({ provider: card.provider.id }))}
          >
            {pending ? 'Pidiendo…' : 'Sincronizar ahora'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setMode('settings')}
          >
            Ajustes
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setMode('connect')}
          >
            {oauth ? 'Volver a conectar' : 'Cambiar llave'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setMode('confirm-disconnect')}
          >
            Desconectar
          </Button>
        </div>
      )}

      {message && (
        <output
          className={clsx(
            'rounded-card px-3 py-2 text-xs',
            message.ok
              ? 'border border-emerald/30 bg-emerald-soft text-emerald'
              : 'border border-rose/30 bg-rose-soft text-rose',
          )}
        >
          {message.text}
        </output>
      )}
    </div>
  );
}
