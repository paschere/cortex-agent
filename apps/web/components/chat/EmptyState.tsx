'use client';

import { motion } from 'framer-motion';
import { BarChart2, FileText, Calendar, Search, UserCheck, Mail, Activity, Sparkles } from 'lucide-react';

interface Suggestion {
  icon: typeof BarChart2;
  text: string;
  /** Optional override sent to the input when clicked (e.g. prefill a slash command). */
  value?: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: BarChart2, text: 'Summarize my pipeline' },
  { icon: Activity, text: 'Get a deal briefing', value: '/briefing ' },
  { icon: FileText, text: 'Draft a proposal for a new client' },
  { icon: Calendar, text: 'Which deals close this month?' },
  { icon: Search, text: 'Research a prospect on the web' },
  { icon: Mail, text: 'Draft a follow-up email' },
  { icon: UserCheck, text: 'Qualify this lead' },
];

export function EmptyState({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8 flex flex-col items-center"
      >
        <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
          <Sparkles className="h-7 w-7" />
        </span>
        <h2 className="mt-5 text-xl font-extrabold tracking-tight text-ink">Zipdev Sales co-pilot</h2>
        <p className="mt-1 max-w-sm text-[13px] text-ink-muted">
          Ask about your pipeline, draft proposals, research prospects, or send follow-ups — grounded in your live CRM and inbox.
        </p>
      </motion.div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s, i) => (
          <motion.button
            key={s.text}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            onClick={() => onSuggestion(s.value ?? s.text)}
            className="group flex items-center gap-2.5 rounded-[14px] border border-border bg-surface p-3 text-left text-[13px] text-ink-muted shadow-card transition-colors hover:border-primary/30 hover:text-ink"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-primary-soft text-primary">
              <s.icon className="h-4 w-4" />
            </span>
            <span>{s.text}</span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
