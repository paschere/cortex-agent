'use client';
import { Button } from '@/components/ui/button';
import {
  type ManagementCase,
  type ManagementCaseData,
  type ManagementEvent,
  managementStateLabels,
} from '@/lib/management/shape';
import { X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { WorkflowPanel } from './WorkflowPanel';
import { caseHistory, saveCase } from './actions';
import { Alert, Field, type Person, PersonOptions, Select } from './form-fields';
export function CaseEditor({
  item,
  data: initial,
  people,
  cases,
  userId,
  isAdmin,
  today,
  onClose,
  onSaved,
}: {
  item?: ManagementCase;
  data: ManagementCaseData;
  people: Person[];
  cases: ManagementCase[];
  userId: string;
  isAdmin: boolean;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const [history, setHistory] = useState<ManagementEvent[] | null>(null);
  const editable = !item || isAdmin || item.created_by === userId || item.data.ownerId === userId;
  const closed = !!item && ['verified', 'cancelled'].includes(item.data.state);
  const field = <K extends keyof ManagementCaseData>(key: K, value: ManagementCaseData[K]) =>
    setData((d) => ({ ...d, [key]: value }));
  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold">{item ? 'Gestionar asunto' : 'Organizar un asunto'}</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Visible para la empresa. Guarda referencias necesarias; los adjuntos del Feed no se
            copian al cerebro.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Cerrar editor">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {item && (
        <WorkflowPanel
          caseId={item.id}
          userId={userId}
          canStart={editable && !closed}
          onEvidence={(e) => setData((d) => ({ ...d, evidence: e, state: 'review' }))}
        />
      )}
      <form
        className="mt-4 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          start(async () => {
            try {
              const result = await saveCase(
                data,
                item ? { id: item.id, revision: item.revision } : {},
              );
              if (result.ok) onSaved();
              else setError(result.error);
            } catch {
              setError('No se pudo guardar. Intenta de nuevo.');
            }
          });
        }}
      >
        <fieldset disabled={!editable || pending || closed} className="space-y-5">
          <Field label="Asunto" value={data.title} onChange={(v) => field('title', v)} required />
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Resultado que necesitamos"
              value={data.objective}
              onChange={(v) => field('objective', v)}
              required
              multiline
            />
            <Field
              label="Cómo sabremos que se logró"
              value={data.successCriteria}
              onChange={(v) => field('successCriteria', v)}
              required
              multiline
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Responsable"
              value={data.ownerId ?? ''}
              onChange={(v) => field('ownerId', v || null)}
            >
              <PersonOptions people={people} />
            </Select>
            <Field
              label="Plazo"
              type="date"
              value={data.dueOn}
              onChange={(v) => field('dueOn', v)}
              required
            />
            <Field
              label="Próxima revisión"
              type="date"
              value={data.nextReviewOn}
              onChange={(v) => field('nextReviewOn', v)}
              required
            />
            <Select
              label="Impacto declarado"
              value={data.impact}
              onChange={(v) => field('impact', v as ManagementCaseData['impact'])}
            >
              <option value="high">Alto</option>
              <option value="medium">Medio</option>
              <option value="low">Bajo</option>
            </Select>
          </div>
          <Field
            label="Próximo paso concreto"
            value={data.nextAction}
            onChange={(v) => field('nextAction', v)}
            required
            multiline
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Select
              label="Estado"
              value={data.state}
              onChange={(v) => field('state', v as ManagementCaseData['state'])}
            >
              {(closed
                ? [item.data.state]
                : item
                  ? [
                      'open',
                      'working',
                      'blocked',
                      'review',
                      'cancelled',
                      ...(isAdmin && item.data.state === 'review' ? ['verified'] : []),
                    ]
                  : ['open']
              ).map((s) => (
                <option key={s} value={s}>
                  {managementStateLabels[s as ManagementCaseData['state']]}
                </option>
              ))}
            </Select>
            <Select
              label="Depende de"
              value={data.dependsOn ?? ''}
              onChange={(v) => field('dependsOn', v || null)}
            >
              <option value="">Sin dependencia</option>
              {cases
                .filter((c) => c.id !== item?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.data.title}
                  </option>
                ))}
            </Select>
          </div>
          <Field
            label="Bloqueo o dato que falta"
            value={data.blocker}
            onChange={(v) => field('blocker', v)}
            required={data.state === 'blocked'}
            multiline
          />
          <Field
            label="Enlace a la fuente o trabajo relacionado (opcional)"
            value={data.sourceUrl ?? ''}
            onChange={(v) => field('sourceUrl', v || null)}
          />
          <div className="space-y-4 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">Evidencia del resultado</h3>
            <p className="text-xs text-ink-muted">
              Referencia a un comprobante o registro y una observación concreta. Adjuntarla no
              confirma su validez automáticamente.
            </p>
            <Field
              label="Referencia de la evidencia (HTTPS o enlace interno)"
              value={data.evidence?.reference ?? ''}
              onChange={(v) =>
                field('evidence', {
                  reference: v,
                  observation: data.evidence?.observation ?? '',
                  observedOn: data.evidence?.observedOn ?? today,
                })
              }
              required={['review', 'verified'].includes(data.state)}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Qué demuestra respecto al criterio de éxito"
                value={data.evidence?.observation ?? ''}
                onChange={(v) =>
                  field('evidence', {
                    reference: data.evidence?.reference ?? '',
                    observation: v,
                    observedOn: data.evidence?.observedOn ?? today,
                  })
                }
                required={['review', 'verified'].includes(data.state)}
                multiline
              />
              <Field
                label="Fecha de observación"
                type="date"
                value={data.evidence?.observedOn ?? ''}
                onChange={(v) =>
                  field('evidence', {
                    reference: data.evidence?.reference ?? '',
                    observation: data.evidence?.observation ?? '',
                    observedOn: v,
                  })
                }
                required={['review', 'verified'].includes(data.state)}
              />
            </div>
            {data.evidence && (
              <Button type="button" variant="ghost" onClick={() => field('evidence', null)}>
                Retirar evidencia propuesta
              </Button>
            )}
            <Field
              label="Veredicto de revisión o motivo de descarte"
              value={data.reviewNote}
              onChange={(v) => field('reviewNote', v)}
              required={['verified', 'cancelled'].includes(data.state)}
              multiline
            />
          </div>
        </fieldset>
        {data.sourceUrl && (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-semibold text-primary"
          >
            Consultar fuente ↗
          </a>
        )}
        {data.evidence && (
          <a
            href={data.evidence.reference}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-4 inline-block text-sm font-semibold text-primary"
          >
            Abrir evidencia ↗
          </a>
        )}
        {!editable && (
          <p className="text-sm text-ink-muted">
            Solo el responsable, el creador o un administrador puede modificar este asunto.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {editable && !closed && (
            <Button type="submit" disabled={pending}>
              {pending
                ? 'Guardando…'
                : data.state === 'verified'
                  ? 'Confirmar revisión y cerrar'
                  : 'Guardar asunto'}
            </Button>
          )}
          {editable && closed && (
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const r = await saveCase(
                      { ...data, state: 'open', reviewNote: '', evidence: null },
                      { id: item.id, revision: item.revision },
                    );
                    if (r.ok) onSaved();
                    else setError(r.error);
                  } catch {
                    setError('No se pudo reabrir.');
                  }
                })
              }
            >
              Reabrir asunto
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Volver a la agenda
          </Button>
          {item && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const r = await caseHistory(item.id);
                    if (r.ok) setHistory(r.events);
                    else setError(r.error);
                  } catch {
                    setError('No se pudo consultar el historial.');
                  }
                })
              }
            >
              Ver historial
            </Button>
          )}
        </div>
      </form>
      {history && (
        <section className="mt-6 space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-bold">Últimas 100 revisiones</h3>
          {history.map((event) => (
            <details key={event.id} className="rounded-lg border border-border p-3 text-sm">
              <summary className="cursor-pointer">
                Revisión {event.revision} · {managementStateLabels[event.data.state]} ·{' '}
                {people.find((p) => p.id === event.actor_id)?.name ||
                  people.find((p) => p.id === event.actor_id)?.email ||
                  'Usuario'}{' '}
                · {new Date(event.created_at).toLocaleString('es-CO')}
              </summary>
              <dl className="mt-3 space-y-2">
                {Object.entries(event.data).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs text-ink-muted">
                      {
                        (
                          {
                            title: 'Asunto',
                            objective: 'Resultado',
                            successCriteria: 'Criterio de éxito',
                            ownerId: 'Responsable',
                            dueOn: 'Plazo',
                            nextReviewOn: 'Revisión',
                            impact: 'Impacto',
                            nextAction: 'Próximo paso',
                            blocker: 'Bloqueo',
                            state: 'Estado',
                            sourceKey: 'Fuente',
                            sourceUrl: 'Enlace',
                            dependsOn: 'Dependencia',
                            evidence: 'Evidencia',
                            reviewNote: 'Veredicto',
                          } as Record<string, string>
                        )[key]
                      }
                    </dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {key === 'ownerId'
                        ? people.find((p) => p.id === value)?.name ||
                          people.find((p) => p.id === value)?.email ||
                          'Sin responsable'
                        : typeof value === 'object'
                          ? JSON.stringify(value, null, 2)
                          : String(value ?? '—')}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
