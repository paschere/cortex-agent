'use client';
import type { ManagementCase, ManagementCaseData } from '@/lib/management/shape';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CaseEditor } from '../CaseEditor';
import { type Person, blankCase } from '../form-fields';

export function MissionWorkspace({
  cases,
  people,
  today,
  userId,
  isAdmin,
  truncated,
}: {
  cases: ManagementCase[];
  people: Person[];
  today: string;
  userId: string;
  isAdmin: boolean;
  truncated: boolean;
}) {
  const router = useRouter();
  const [editor, setEditor] = useState<{ item?: ManagementCase; data: ManagementCaseData } | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Primera misión acompañada
          </p>
          <h1 className="mt-2 text-2xl font-bold">De una factura a un cierre comprobado.</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">
            Cortex prepara el cobro, espera tu aprobación y sigue la respuesta. El cierre requiere
            pagos confirmados y revisión humana.
          </p>
        </div>
        <Link href="/onboarding?step=mission" className="text-sm text-primary">
          Volver a configuración →
        </Link>
      </header>
      <ol className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        {[
          [
            '01 · Acordar el encargo',
            'Responsable, fecha y criterio de cierre. Los datos que guardes en el asunto serán visibles para la empresa.',
          ],
          [
            '02 · Preparar y aprobar',
            'Factura confirmada, saldo comprobado y destinatario explícito. El envío se revisa en Acciones.',
          ],
          [
            '03 · Comprobar el resultado',
            'Una respuesta abre la revisión; no salda una factura. Adjunta la evidencia y pide la verificación.',
          ],
        ].map(([title, body]) => (
          <li key={title} className="bg-surface p-5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-ink-muted">{body}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-4 text-sm font-semibold text-primary">
        <Link href="/management/control">Autonomía y calidad de datos →</Link>
        <Link href="/schedules">Canales y rutinas →</Link>
        <Link href="/management/review">Resultados de la semana →</Link>
      </div>
      {notice && <output className="block text-sm">{notice}</output>}
      {editor ? (
        <CaseEditor
          key={`${editor.item?.id ?? 'new'}:${editor.item?.revision ?? 0}`}
          {...editor}
          people={people}
          cases={cases}
          userId={userId}
          isAdmin={isAdmin}
          today={today}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            if (saved) setEditor({ item: saved, data: saved.data });
            setNotice(
              saved?.data.state === 'verified'
                ? 'Cierre verificado y guardado con su evidencia.'
                : 'Asunto guardado. Continúa con el proceso de cobro y revisa sus permisos antes de iniciarlo.',
            );
            router.refresh();
          }}
        />
      ) : (
        <section className="space-y-4 rounded-xl border border-border p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Elige el asunto que vas a acompañar</h2>
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white"
              type="button"
              onClick={() =>
                setEditor({
                  data: {
                    ...blankCase(today, 2),
                    dueOn: new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400000)
                      .toISOString()
                      .slice(0, 10),
                    title: 'Seguimiento de cartera',
                    objective:
                      'Resolver el saldo de una factura con el cliente y dejar evidencia verificable.',
                    successCriteria:
                      'Saldo cubierto por pagos confirmados vinculados a la factura y cierre revisado por un administrador.',
                    ownerId: userId,
                    nextAction:
                      'Seleccionar una factura confirmada, comprobar el saldo y preparar el cobro.',
                  },
                })
              }
            >
              Preparar una misión
            </button>
          </div>
          <p className="text-xs text-ink-muted">
            Crear el asunto no autoriza un envío ni inicia el seguimiento.
          </p>
          {cases
            .filter((c) => !['verified', 'cancelled'].includes(c.data.state))
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className="block w-full border-t border-border py-3 text-left text-sm hover:text-primary"
                onClick={() => setEditor({ item: c, data: c.data })}
              >
                {c.data.title} <span className="text-ink-muted">· {c.data.dueOn}</span>
              </button>
            ))}
          {truncated && (
            <p className="text-xs text-ink-muted">
              Vista parcial. Consulta la agenda para localizar otros asuntos.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
