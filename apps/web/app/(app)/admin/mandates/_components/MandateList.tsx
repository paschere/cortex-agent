'use client';

import { Panel } from '@/components/ui/panel';
import type { MandateUsage } from '@/lib/mandates/delegation';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CalendarClock, KeyRound, Loader2, ShieldOff, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Lo que hay concedido ahora mismo, dicho en frases completas.
 *
 * La tentación aquí es una tabla con columnas cortas. No sirve: una fila de esta
 * tabla es un permiso, y un permiso que se lee en abreviaturas es un permiso que
 * nadie revisa. Cada tarjeta dice, en una frase, qué se autorizó y hasta cuándo,
 * y la lista de herramientas está desplegable pero completa — sin «y 14 más».
 *
 * ===========================================================================
 * LO QUE HA HECHO, Y CUÁNDO FUE LA ÚLTIMA VEZ
 * ===========================================================================
 * Una concesión sin uso es la que más urge revisar y la que menos se nota, así
 * que el silencio se dice en voz alta: un mandato en vigor que nadie ha ejercido
 * lleva su propia etiqueta, y la frase de al lado distingue «nunca desde que se
 * concedió» de «no en la ventana que se pudo mirar». Un permiso que lleva dos
 * meses sin usarse es un permiso que sobra, y esta pantalla es el único sitio
 * donde alguien va a darse cuenta.
 *
 * El detalle de uso se agrupa POR HERRAMIENTA, con contador y última fecha, y no
 * es un registro de eventos: ese ya existe y es la auditoría. Cuarenta envíos de
 * correo son una línea que dice cuarenta, porque la pregunta que se contesta
 * aquí es «¿esto sigue teniendo sentido?» y no «¿qué pasó a las 14:32?».
 */

export interface MandateView {
  id: string;
  label: string;
  reason: string;
  state: 'active' | 'revoked' | 'expired' | 'scheduled';
  daysLeft: number;
  patterns: string[];
  covered: { id: string; label: string }[];
  maxRiskLevel: string;
  amountCeiling: number | null;
  currency: string | null;
  appliesUnattended: boolean;
  maxUsesPerDay: number | null;
  grantedBy: string;
  revokedBy: string | null;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** Lo ejercido dentro de la ventana, agrupado por herramienta. */
  usage: MandateUsage;
  /** «La última vez fue hace 3 días» / «No lo ha ejercido…», ya compuesta. */
  lastUseNote: string;
}

const STATE: Record<MandateView['state'], { label: string; tone: StatusTone }> = {
  active: { label: 'en vigor', tone: 'amber' },
  scheduled: { label: 'aún no empieza', tone: 'neutral' },
  expired: { label: 'caducado', tone: 'neutral' },
  revoked: { label: 'revocado', tone: 'rose' },
};

const RISK_ES: Record<string, string> = { low: 'bajo', medium: 'medio', high: 'alto' };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString('es-CO')} ${currency}`;
}

export function MandateList({
  mandates,
  usesWindowDays,
  activeCount,
  usesTruncated,
}: {
  mandates: MandateView[];
  usesWindowDays: number;
  activeCount: number;
  /** La consulta de usos llegó al tope: los contadores son un mínimo. */
  usesTruncated?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedUses, setExpandedUses] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(m: MandateView) {
    if (
      !window.confirm(
        `Revocar «${m.label}». A partir de la siguiente llamada, Cortex volverá a preguntarte antes de usar esas ${m.covered.length} herramientas. ¿Seguimos?`,
      )
    ) {
      return;
    }
    setWorking(m.id);
    setError(null);
    try {
      const res = await fetch(`/api/mandates/${m.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'No se pudo revocar.');
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo hablar con el servidor.');
    } finally {
      setWorking(null);
    }
  }

  if (mandates.length === 0) {
    return (
      <Panel className="px-4 py-12 text-center">
        <KeyRound className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
        <p className="text-[13px] font-semibold text-ink">No hay ningún mandato concedido</p>
        <p className="mx-auto mt-1 max-w-lg text-[12.5px] leading-relaxed text-ink-muted">
          Cortex te pregunta antes de cada acción que sale de la empresa o que toca datos delicados.
          Así seguirá mientras esta lista esté vacía.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="field-label">Mandatos</div>
        <span className="text-[11px] text-ink-faint">
          {activeCount === 0
            ? 'ninguno en vigor'
            : `${activeCount} en vigor · ${mandates.length} en total`}
        </span>
      </div>

      {error && (
        <div className="border-b border-border bg-rose-soft px-4 py-2 text-[12px] text-rose">
          {error}
        </div>
      )}

      <ul>
        {mandates.map((m) => {
          const st = STATE[m.state];
          const isOpen = expanded === m.id;
          const usesOpen = expandedUses === m.id;
          // Un permiso en vigor que nadie ejerce. No es un error, y por eso el
          // tono es neutro: es una pregunta abierta que solo se puede ver aquí.
          const idle = m.state === 'active' && m.usage.calls === 0;
          return (
            <li key={m.id} className="border-t border-border first:border-t-0">
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-bold text-ink">{m.label}</span>
                      <span className={chipClass(st.tone)}>{st.label}</span>
                      {m.appliesUnattended && (
                        <span className={chipClass('neutral')}>también en rutinas</span>
                      )}
                      {idle && <span className={chipClass('neutral')}>sin ejercer</span>}
                    </div>

                    {/* La frase completa. Es lo que alguien tiene que poder leer
                        de un vistazo dentro de seis meses. */}
                    <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-ink-muted">
                      Cortex usa{' '}
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : m.id)}
                        className="font-semibold text-primary hover:underline"
                      >
                        {m.covered.length} herramientas
                      </button>{' '}
                      sin preguntar, hasta riesgo{' '}
                      <strong className="text-ink">
                        {RISK_ES[m.maxRiskLevel] ?? m.maxRiskLevel}
                      </strong>
                      {m.amountCeiling !== null && m.currency !== null && (
                        <>
                          {' '}
                          y hasta{' '}
                          <strong className="text-ink">
                            {formatMoney(m.amountCeiling, m.currency)}
                          </strong>{' '}
                          por acción
                        </>
                      )}
                      {m.maxUsesPerDay !== null && (
                        <>
                          , como mucho{' '}
                          <strong className="text-ink">{m.maxUsesPerDay} veces al día</strong>
                        </>
                      )}
                      {m.state === 'active' ? (
                        <>
                          , hasta el <strong className="text-ink">{formatDate(m.expiresAt)}</strong>{' '}
                          ({m.daysLeft} {m.daysLeft === 1 ? 'día' : 'días'}).
                        </>
                      ) : m.state === 'revoked' ? (
                        <>
                          . Revocado el {formatDate(m.revokedAt ?? m.expiresAt)}
                          {m.revokedBy ? ` por ${m.revokedBy}` : ''}: ya no autoriza nada.
                        </>
                      ) : m.state === 'expired' ? (
                        <>. Caducó el {formatDate(m.expiresAt)}: ya no autoriza nada.</>
                      ) : (
                        <>. Empieza el {formatDate(m.startsAt)}.</>
                      )}
                    </p>

                    {m.reason && (
                      <p className="mt-1.5 max-w-3xl border-l-2 border-border pl-2.5 text-[12px] italic leading-relaxed text-ink-faint">
                        {m.reason}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        Concedido por {m.grantedBy}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" />
                        {formatDate(m.createdAt)}
                      </span>
                      <span className="tabular">Patrones: {m.patterns.join(' · ') || '—'}</span>
                    </div>

                    {/* Lo que ha hecho, que es la mitad de por qué esta pantalla
                        existe: un permiso solo se puede revisar sabiendo si se
                        usa y para qué. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-muted">
                      <span className={idle ? 'font-semibold text-ink' : undefined}>
                        {m.lastUseNote}
                      </span>
                      {m.usage.calls > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <button
                            type="button"
                            onClick={() => setExpandedUses(usesOpen ? null : m.id)}
                            aria-expanded={usesOpen}
                            className="font-semibold text-primary hover:underline"
                          >
                            Actuó solo {usesTruncated ? 'al menos ' : ''}
                            {m.usage.calls} {m.usage.calls === 1 ? 'vez' : 'veces'} en{' '}
                            {usesWindowDays} días
                          </button>
                        </>
                      )}
                      {m.usage.money.map((mm) => (
                        <span key={mm.currency} className="tabular">
                          · movió {formatMoney(mm.total, mm.currency)}
                        </span>
                      ))}
                    </div>

                    {usesOpen && (
                      <ul className="mt-2 max-w-3xl divide-y divide-border rounded-sm border border-border bg-surface-2 text-[11.5px]">
                        {m.usage.byTool.map((t) => (
                          <li
                            key={t.toolId}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-2.5 py-1.5"
                          >
                            <span className="text-ink">{t.label}</span>
                            <span className="tabular text-ink-faint">
                              {t.calls} {t.calls === 1 ? 'vez' : 'veces'} · última el{' '}
                              {formatDate(t.lastAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {m.state !== 'revoked' && (
                    <button
                      type="button"
                      onClick={() => revoke(m)}
                      disabled={working === m.id}
                      className={clsx(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-rose/25 bg-rose-soft px-3 py-1.5 text-[12px] font-semibold text-rose',
                        'transition-all duration-150 hover:-translate-y-px disabled:opacity-50 motion-reduce:transform-none',
                      )}
                    >
                      {working === m.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldOff className="h-3.5 w-3.5" />
                      )}
                      Revocar
                    </button>
                  )}
                </div>

                {isOpen && (
                  <ul className="tabular mt-2 grid gap-0.5 rounded-sm border border-border bg-surface-2 p-2.5 text-[11px] text-ink-muted md:grid-cols-2">
                    {m.covered.map((t) => (
                      <li key={t.id} className="truncate" title={t.label}>
                        {t.id}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
