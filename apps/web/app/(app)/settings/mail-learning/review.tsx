'use client';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { reviewLearning } from './actions';
export type Proposal = {
  id: string;
  thread_id: string;
  state: 'pending' | 'approved' | 'case_only' | 'discarded';
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  document_id: string | null;
  draft: {
    title: string;
    content: string;
    kind: string;
    uncertainty: string;
    citations: { messageId: string; quote: string }[];
  };
};
export function MailLearningReview({
  proposals,
  spaces,
  partial,
}: { proposals: Proposal[]; spaces: { id: string; name: string }[]; partial: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(
    proposals.find((p) => p.state === 'pending')?.id ?? proposals[0]?.id ?? '',
  );
  const p = proposals.find((p) => p.id === selected);
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-primary">
            Correo · aprendizaje revisado
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Qué merece quedarse</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">
            Un correo puede explicar un caso sin definir una regla. Confirma el alcance y revisa el
            contenido antes de guardarlo.
          </p>
        </div>
        <Link href="/settings#correo" className="text-sm text-primary">
          Configurar mi correo →
        </Link>
      </header>
      <p className="rounded-lg border border-border bg-surface-raised p-4 text-sm">
        Esta bandeja y sus citas son privadas. Compartir un aprendizaje publica únicamente el texto
        que revises y tu criterio, no el hilo ni los extractos.
      </p>
      {message && <output className="block text-sm text-primary">{message}</output>}
      {partial && (
        <p className="text-sm text-amber">Se muestran las 50 propuestas más recientes.</p>
      )}
      {!p ? (
        <section className="rounded-xl border border-dashed border-border p-8">
          <h2 className="font-medium">Todavía no hay aprendizajes por revisar</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Activa las propuestas en Ajustes o pide a Cortex que revise un hilo concreto. Conectar
            Gmail no guarda sus correos en el cerebro.
          </p>
          <Link
            className="mt-4 inline-block text-sm text-primary"
            href="/chat?prompt=Ay%C3%BAdame%20a%20encontrar%20un%20correo%20%C3%BAtil%20para%20ense%C3%B1ar%20un%20proceso.%20Consulta%20Gmail%20y%20p%C3%ADdeme%20elegir%20el%20hilo%20antes%20de%20usar%20gmail.propose_learning.%20No%20archives%20el%20correo%20completo."
          >
            Elegir un correo con Cortex →
          </Link>
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <nav aria-label="Propuestas de aprendizaje" className="space-y-2">
            {proposals.map((row) => (
              <button
                type="button"
                key={row.id}
                disabled={busy}
                aria-pressed={p.id === row.id}
                onClick={() => {
                  setSelected(row.id);
                  setMessage('');
                }}
                className={`w-full rounded-lg border p-3 text-left text-sm ${p.id === row.id ? 'border-primary bg-primary/10' : 'border-border'}`}
              >
                <span className="block font-medium">{row.draft.title}</span>
                <span className="mt-1 block text-xs text-ink-muted">
                  {
                    {
                      pending: 'Por revisar',
                      approved: 'Confirmado',
                      case_only: 'Solo este caso',
                      discarded: 'Descartado',
                    }[row.state]
                  }{' '}
                  · {new Date(row.created_at).toLocaleDateString('es-CO')}
                </span>
              </button>
            ))}
          </nav>
          <article key={p.id} className="space-y-5">
            <div>
              <p className="text-xs text-primary">
                {p.draft.kind === 'possible_rule'
                  ? 'Posible regla · necesita confirmación'
                  : 'Hecho de un caso · no es una regla general'}
              </p>
              <h2 className="mt-1 text-xl font-semibold">{p.draft.title}</h2>
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">De dónde sale</h3>
              {p.draft.citations.map((c) => (
                <blockquote
                  key={c.messageId + c.quote}
                  className="border-l-2 border-primary pl-4 text-sm text-ink-muted"
                >
                  {c.quote}
                </blockquote>
              ))}
              <a
                href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(p.thread_id)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-sm text-primary"
              >
                Abrir el hilo original en Gmail →
              </a>
            </section>
            <section className="rounded-lg border border-amber/30 p-4">
              <h3 className="text-sm font-medium">Qué hay que confirmar</h3>
              <p className="mt-1 text-sm text-ink-muted">{p.draft.uncertainty}</p>
              <Link href="/management/control" className="mt-2 inline-block text-sm text-primary">
                Contrastar con documentos y procesos vigentes →
              </Link>
            </section>
            {p.state === 'pending' ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const decision = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
                  start(async () => {
                    setMessage('');
                    try {
                      const r = await reviewLearning({
                        id: p.id,
                        decision,
                        note: data.get('note'),
                        content: data.get('content'),
                        title: data.get('title'),
                        spaceId: data.get('spaceId') || null,
                      });
                      if (!r.ok) setMessage(r.error);
                      else {
                        setMessage(
                          r.documentId
                            ? 'Aprendizaje guardado. Su indexación semántica se completa en segundo plano.'
                            : 'Revisión guardada sin añadir conocimiento al cerebro.',
                        );
                        router.refresh();
                      }
                    } catch {
                      setMessage(
                        'No se pudo guardar. Revisa la conexión y actualiza antes de volver a intentar.',
                      );
                    }
                  });
                }}
              >
                <fieldset disabled={busy} className="space-y-4">
                  <label className="block text-sm">
                    Título del conocimiento
                    <input
                      name="title"
                      required
                      minLength={3}
                      maxLength={160}
                      defaultValue={p.draft.title}
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2"
                    />
                  </label>
                  <label className="block text-sm font-medium">
                    Contenido que quieres conservar
                    <textarea
                      name="content"
                      required
                      minLength={20}
                      maxLength={5000}
                      defaultValue={p.draft.content}
                      rows={7}
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 font-normal"
                    />
                  </label>
                  <label className="block text-sm">
                    Dónde se podrá usar
                    <select
                      name="spaceId"
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2"
                    >
                      <option value="">Solo mi cerebro personal</option>
                      {spaces.map((s) => (
                        <option key={s.id} value={s.id}>
                          Compartido: {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Por qué lo confirmas, limitas a este caso o descartas
                    <textarea
                      name="note"
                      required
                      minLength={10}
                      maxLength={1500}
                      rows={3}
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2"
                      placeholder="Indica el alcance, vigencia y quién confirmó la regla. Si contradice el manual, explica qué queda pendiente."
                    />
                  </label>
                  <p className="text-xs text-ink-muted">
                    Guardar crea un conocimiento revisado. No modifica ni sustituye automáticamente
                    un manual existente.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button name="decision" value="approved">
                      Confirmar y guardar
                    </Button>
                    <Button variant="outline" name="decision" value="case_only">
                      Solo este caso
                    </Button>
                    <Button variant="ghost" name="decision" value="discarded">
                      Descartar
                    </Button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-sm">{p.review_note}</p>
                <p className="text-xs text-ink-muted">
                  Revisado: {p.reviewed_at ? new Date(p.reviewed_at).toLocaleString('es-CO') : '—'}
                </p>
                {p.document_id && (
                  <Link href="/kb" className="text-sm text-primary">
                    Ver conocimiento guardado →
                  </Link>
                )}
              </div>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
