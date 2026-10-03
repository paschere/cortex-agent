'use client';

import { FIELD, Feedback, Modal, NUMBER_FIELD, readNumber } from '@/components/inventory/parts';
import { Button } from '@/components/ui/button';
import type { ActionResult, Option, ProjectChoice } from '@/lib/projects/shape';
import { LoaderCircle, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * «REGISTRAR HORAS»: el mismo diálogo en /proyectos, en el detalle de un
 * proyecto y en «Mi semana». Por defecto son de quien lo abre, de hoy y
 * cobrables; las de otra persona sólo si `people` llega (quien administra o el
 * responsable).
 */
export interface LogTimeInput {
  projectId: string;
  hours: number;
  date: string;
  userId: string | null;
  billable: boolean;
  note: string | null;
}

export function LogTimeDialog({
  projects,
  fixedProjectId,
  people,
  today,
  onClose,
  logTime,
}: {
  projects: ProjectChoice[];
  fixedProjectId?: string;
  people?: Option[];
  today: string;
  onClose: () => void;
  logTime: (input: LogTimeInput) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? '');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(today);
  const [userId, setUserId] = useState('');
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const h = readNumber(hours);
    if (!projectId) return setResult({ ok: false, error: 'Elige el proyecto.' });
    if (h === null || h <= 0 || h > 24)
      return setResult({ ok: false, error: 'Las horas van entre 0 y 24.' });
    start(async () => {
      const r = await logTime({
        projectId,
        hours: h,
        date,
        userId: userId || null,
        billable,
        note: note.trim() || null,
      });
      setResult(r);
      if (r.ok) {
        setHours('');
        setNote('');
        router.refresh();
      }
    });
  };

  return (
    <Modal
      title="Registrar horas"
      subtitle="Quedan con el costo por hora de la persona, congelado desde hoy."
      onClose={onClose}
    >
      <div className="space-y-4">
        {!fixedProjectId && (
          <label className="block text-xs font-semibold text-ink-muted">
            Proyecto u orden
            <select
              className={`${FIELD} mt-1.5`}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold text-ink-muted">
            Horas
            <input
              className={`${NUMBER_FIELD} mt-1.5`}
              inputMode="decimal"
              placeholder="6"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: el diálogo existe para escribir esto.
              autoFocus
            />
          </label>
          <label className="block text-xs font-semibold text-ink-muted">
            Día
            <input
              className={`${FIELD} mt-1.5`}
              type="date"
              max={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        {people && people.length > 0 && (
          <label className="block text-xs font-semibold text-ink-muted">
            De quién
            <select
              className={`${FIELD} mt-1.5`}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Mías</option>
              {people.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-xs font-semibold text-ink-muted">
          Qué se hizo (opcional)
          <input
            className={`${FIELD} mt-1.5`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Se le cobran al cliente
        </label>
        <Feedback result={result} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Timer className="h-4 w-4" aria-hidden />
            )}
            Registrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
