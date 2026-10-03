'use client';

import { Button } from '@/components/ui/button';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, FileText, Loader2, Quote, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Field, INPUT } from './NewExpiration';
import type { ActionResult, ConfirmInput, Option, ReviewItem } from './types';

/**
 * «POR REVISAR»: lo que Cortex leyó de un documento y nadie ha confirmado.
 *
 * Cada tarjeta enseña LA FRASE de donde salió la fecha, al lado de la fecha,
 * para que confirmar sea comparar dos cosas a la vista y no un acto de fe. La
 * fecha se puede corregir antes de confirmar (la cita queda como estaba); sin
 * fecha no se confirma. Hasta el clic, nada de esto se vigila.
 */

const CONFIDENCE_TONE = { alta: 'emerald', media: 'amber', baja: 'rose' } as const;

export function ReviewQueue({
  items,
  kinds,
  team,
  onConfirm,
  onDiscard,
}: {
  items: ReviewItem[];
  kinds: Option[];
  team: Option[];
  onConfirm?: (input: ConfirmInput) => Promise<ActionResult>;
  onDiscard?: (input: { id: string; reason: string }) => Promise<ActionResult>;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-border bg-surface px-6 py-10 text-center">
        <p className="text-sm font-semibold text-ink">Nada por revisar</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
          Cuando llegue al Cerebro un SOAT, una póliza, una licencia o un contrato, Cortex le lee la
          fecha y la deja aquí para que la confirmes.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <ReviewCard
          key={item.id}
          item={item}
          kinds={kinds}
          team={team}
          onConfirm={onConfirm}
          onDiscard={onDiscard}
        />
      ))}
    </ul>
  );
}

function ReviewCard({
  item,
  kinds,
  team,
  onConfirm,
  onDiscard,
}: {
  item: ReviewItem;
  kinds: Option[];
  team: Option[];
  onConfirm?: (input: ConfirmInput) => Promise<ActionResult>;
  onDiscard?: (input: { id: string; reason: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [expiresOn, setExpiresOn] = useState(item.expiresOn ?? '');
  const [kind, setKind] = useState(item.kind);
  const [subject, setSubject] = useState(item.subject ?? '');
  const [owner, setOwner] = useState(item.ownerId ?? '');
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const id = item.id;

  function confirm() {
    if (!onConfirm) return;
    setResult(null);
    start(async () => {
      const r = await onConfirm({
        id,
        expiresOn: expiresOn && expiresOn !== item.expiresOn ? expiresOn : undefined,
        kind: kind !== item.kind ? kind : undefined,
        subject: subject.trim() !== (item.subject ?? '') ? subject.trim() : undefined,
        ownerUserId: owner && owner !== item.ownerId ? owner : undefined,
      });
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  function discard() {
    if (!onDiscard) return;
    start(async () => {
      const r = await onDiscard({ id, reason: reason.trim() || 'No es un papel que venza' });
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  const corrected = expiresOn && item.expiresOn && expiresOn !== item.expiresOn;

  return (
    <li className="rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{item.title}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {item.kindLabel}
            {item.issuer ? ` · ${item.issuer}` : ''}
            {item.number ? ` · No. ${item.number}` : ''}
          </p>
        </div>
        <span className={chipClass(CONFIDENCE_TONE[item.confidence])}>
          Confianza {item.confidenceLabel.toLowerCase()}
        </span>
      </div>

      <figure className="mt-3 rounded-sm border-l-2 border-primary/50 bg-surface-2 px-3 py-2">
        <Quote className="mb-1 h-3.5 w-3.5 text-ink-faint" aria-hidden />
        <blockquote className="text-sm leading-snug text-ink">
          {item.evidenceHidden
            ? 'El documento está en un espacio del Cerebro que no ves.'
            : item.evidence
              ? `«${item.evidence}»`
              : 'No encontré una frase que diga la fecha con día, mes y año.'}
        </blockquote>
        {item.documentHref && (
          <figcaption className="mt-1.5 text-xs text-ink-faint">
            <Link
              href={item.documentHref}
              className="inline-flex items-center gap-1 hover:text-primary"
            >
              <FileText className="h-3 w-3" aria-hidden />
              {item.documentTitle ?? 'Ver el documento'}
            </Link>
          </figcaption>
        )}
      </figure>
      {item.reviewNote && (
        <p className="mt-2 text-xs leading-snug text-amber">Ojo: {item.reviewNote}.</p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label="Vence el" htmlFor={`rv-exp-${id}`}>
          <input
            id={`rv-exp-${id}`}
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            className={clsx(INPUT, 'tabular', !expiresOn && 'border-amber')}
          />
        </Field>
        <Field label="Tipo" htmlFor={`rv-kind-${id}`}>
          <select
            id={`rv-kind-${id}`}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={INPUT}
          >
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={item.subjectKind === 'vehiculo' ? 'Placa' : 'De qué o de quién'}
          htmlFor={`rv-subj-${id}`}
        >
          <input
            id={`rv-subj-${id}`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Sin sujeto"
            className={INPUT}
          />
        </Field>
        <Field label="Responsable" htmlFor={`rv-owner-${id}`}>
          <select
            id={`rv-owner-${id}`}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className={INPUT}
          >
            <option value="">Yo</option>
            {team.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {corrected && (
        <p className="mt-2 text-xs text-ink-muted">
          Vas a corregir la fecha leída ({item.expiresOn}). La cita queda como estaba y la fecha
          queda a tu nombre.
        </p>
      )}

      {discarding ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <Field label="¿Por qué no es un papel que vence?" htmlFor={`rv-why-${id}`}>
              <input
                id={`rv-why-${id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Es una cotización, es de otra empresa…"
                className={INPUT}
              />
            </Field>
          </div>
          <Button type="button" variant="outline" onClick={() => setDiscarding(false)}>
            Volver
          </Button>
          <Button type="button" variant="danger" onClick={discard} disabled={pending}>
            Descartar
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDiscarding(true)}
            disabled={pending}
          >
            <X className="h-4 w-4" aria-hidden />
            No es un vencimiento
          </Button>
          <Button type="button" onClick={confirm} disabled={pending || !expiresOn}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Check className="h-4 w-4" aria-hidden />
            )}
            Confirmar y vigilar
          </Button>
        </div>
      )}
      {result && (
        <p
          aria-live="polite"
          className={clsx(
            'mt-2 rounded-sm px-3 py-2 text-xs leading-snug',
            result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {result.ok ? result.note : result.error}
        </p>
      )}
    </li>
  );
}
