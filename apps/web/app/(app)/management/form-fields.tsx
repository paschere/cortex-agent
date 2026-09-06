'use client';
import type { ManagementCaseData } from '@/lib/management/shape';
import { type ReactNode, useId } from 'react';
export type Person = { id: string; name: string | null; email: string };
const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60';
export function Field({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  disabled = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-ink-muted">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={inputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          required={required}
          disabled={disabled}
        />
      ) : (
        <input
          id={id}
          className={inputClass}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          disabled={disabled}
        />
      )}
    </div>
  );
}
export function Select({
  label,
  value,
  onChange,
  children,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    </div>
  );
}
export function PersonOptions({ people }: { people: Person[] }) {
  return (
    <>
      <option value="">Sin asignar</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name || p.email}
        </option>
      ))}
    </>
  );
}
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-sm text-ink">
      {children}
    </p>
  );
}
export function blankCase(today: string, reviewDays: number): ManagementCaseData {
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + reviewDays);
  return {
    title: '',
    objective: '',
    successCriteria: '',
    ownerId: null,
    dueOn: today,
    nextReviewOn: next.toISOString().slice(0, 10),
    impact: 'medium',
    nextAction: '',
    blocker: '',
    state: 'open',
    sourceKey: null,
    sourceUrl: null,
    dependsOn: null,
    evidence: null,
    reviewNote: '',
  };
}
