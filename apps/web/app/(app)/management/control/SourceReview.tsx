'use client';
import type { KnowledgeReview } from '@/lib/management/knowledge-review-shape';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { compareSources, resolveSourceReview } from './review-actions';
const inputClass = 'w-full rounded-lg border border-border bg-surface p-3 text-sm';
export function SourceReview({
  documents,
  reviews,
  unavailable,
}: {
  documents: { id: string; title: string | null }[];
  reviews: KnowledgeReview[];
  unavailable: boolean;
}) {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [decision, setDecision] = useState('');
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <section className="space-y-4 rounded-xl border border-border p-5">
      <div>
        <h2 className="font-semibold">Contrastar fuentes antes de decidir</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Cortex propone diferencias con citas textuales. Tú confirmas su interpretación. Estas
          revisiones son personales y no cambian los documentos del cerebro. Se muestran hasta 50
          revisiones recientes.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            try {
              const r = await compareSources({ left, right, decision });
              setMessage(r.ok ? r.message : r.error);
              if (r.ok) router.refresh();
            } catch {
              setMessage('No se pudo completar la comparación. Inténtalo de nuevo.');
            }
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            Fuente A
            <select
              required
              className={inputClass}
              value={left}
              disabled={pending}
              onChange={(e) => setLeft(e.target.value)}
            >
              <option value="">Seleccionar documento</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || 'Sin título'}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            Fuente B
            <select
              required
              className={inputClass}
              value={right}
              disabled={pending}
              onChange={(e) => setRight(e.target.value)}
            >
              <option value="">Seleccionar documento</option>
              {documents
                .filter((d) => d.id !== left)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title || 'Sin título'}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="block space-y-2 text-sm">
          Qué decisión depende de estos datos
          <textarea
            required
            minLength={10}
            maxLength={1000}
            className={inputClass}
            disabled={pending}
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder="Por ejemplo: confirmar qué plazo de entrega podemos prometer."
          />
        </label>
        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white"
          disabled={pending || !left || !right || left === right || decision.trim().length < 10}
          type="submit"
        >
          {pending ? 'Comparando citas…' : 'Comparar fuentes'}
        </button>
        <p className="text-xs text-ink-muted">
          Hasta 8 fragmentos por fuente. La comparación requiere revisión humana.
        </p>
      </form>
      {message && <output className="block text-sm">{message}</output>}
      {unavailable && <p className="text-sm">No se pudieron cargar las revisiones guardadas.</p>}
      {reviews.map((r) => (
        <Review key={r.id} review={r} documents={documents} />
      ))}
    </section>
  );
}
function Review({
  review: r,
  documents,
}: { review: KnowledgeReview; documents: { id: string; title: string | null }[] }) {
  const [resolution, setResolution] = useState('context');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  const name = (id: string) => documents.find((d) => d.id === id)?.title || 'Documento';
  return (
    <article className="space-y-3 border-t border-border pt-5">
      <h3 className="font-semibold">{r.finding.issue}</h3>
      <p className="text-sm">Decisión afectada: {r.finding.decision}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          [r.left_document, r.finding.leftQuote],
          [r.right_document, r.finding.rightQuote],
        ].map(([id, quote]) => (
          <div key={id}>
            <p className="text-xs font-semibold text-primary">{name(id ?? '')}</p>
            <blockquote className="mt-2 border-l-2 border-primary pl-3 text-sm text-ink-muted">
              {quote}
            </blockquote>
          </div>
        ))}
      </div>
      <p className="text-sm">{r.finding.question}</p>
      {r.resolution === 'pending' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              try {
                const result = await resolveSourceReview({ id: r.id, resolution, note });
                if (result.ok) router.refresh();
                else setError(result.error);
              } catch {
                setError('No se pudo registrar la revisión. Inténtalo de nuevo.');
              }
            });
          }}
        >
          <label className="block text-sm">
            Mi conclusión
            <select
              className={inputClass}
              value={resolution}
              disabled={pending}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="context">Falta contexto para decidir</option>
              <option value="left">Usar la fuente A para esta decisión</option>
              <option value="right">Usar la fuente B para esta decisión</option>
              <option value="both">Ambas aplican en contextos diferentes</option>
            </select>
          </label>
          <label className="block text-sm">
            Criterio de revisión
            <textarea
              required
              minLength={10}
              maxLength={2000}
              className={inputClass}
              disabled={pending}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            disabled={pending || note.trim().length < 10}
            type="submit"
            className="rounded-lg border border-border px-3 py-2 text-sm font-semibold"
          >
            Registrar mi revisión
          </button>
          {error && <p className="text-sm">{error}</p>}
        </form>
      ) : (
        <p className="text-sm text-ink-muted">
          Revisión registrada el {r.resolved_at?.slice(0, 10)} ·{' '}
          {{
            left: 'Usar fuente A',
            right: 'Usar fuente B',
            both: 'Ambas en contextos diferentes',
            context: 'Falta contexto',
          }[r.resolution] ?? r.resolution}
          : {r.note}
        </p>
      )}
    </article>
  );
}
