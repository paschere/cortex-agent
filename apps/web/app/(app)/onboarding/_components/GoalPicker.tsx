'use client';

import { GOAL_LABEL, ONBOARDING_GOALS, type OnboardingGoal } from '@/lib/plan-shape';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * The one question.
 *
 * It is asked because the answer CHANGES SOMETHING: it reorders the steps below
 * and decides whether this person is sent to connect their mail or to bring
 * their documents. A question whose answer changes nothing is a form, and a form
 * is the last thing somebody who just signed up needs.
 *
 * Answering re-renders the server component, which is where the ordering lives.
 * It is also changeable afterwards — the first answer is a guess about your own
 * company and people are allowed to be wrong about that.
 */
export function GoalPicker({ current }: { current: OnboardingGoal | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState<OnboardingGoal | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(goal: OnboardingGoal) {
    setSaving(goal);
    setFailed(false);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      if (!res.ok) throw new Error('failed');
      startTransition(() => router.refresh());
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {ONBOARDING_GOALS.map((goal) => {
          const active = current === goal;
          return (
            <button
              key={goal}
              type="button"
              onClick={() => void choose(goal)}
              disabled={saving !== null || pending}
              aria-pressed={active}
              className={clsx(
                'rounded-card border p-4 text-left transition-all duration-150 hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none',
                active
                  ? 'border-primary/30 bg-primary-soft shadow-card'
                  : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2',
                (saving !== null || pending) && 'opacity-70',
              )}
            >
              <div
                className={clsx(
                  'text-[13px] font-semibold leading-snug',
                  active ? 'text-primary-ink' : 'text-ink',
                )}
              >
                {GOAL_LABEL[goal].title}
              </div>
              <div className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
                {GOAL_LABEL[goal].detail}
              </div>
            </button>
          );
        })}
      </div>
      {failed && (
        <p className="mt-3 text-[12px] text-rose">
          No se pudo guardar tu respuesta. Vuelve a tocarla en un momento.
        </p>
      )}
    </div>
  );
}
