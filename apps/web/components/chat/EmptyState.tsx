'use client';

import { motion } from 'framer-motion';
import { BarChart2, FileText, Calendar, Search, UserCheck, Phone, Activity } from 'lucide-react';

interface Suggestion {
  icon: typeof BarChart2;
  text: string;
  // Optional override sent to the input when the card is clicked.
  // Used by the briefing card to prefill the /briefing slash command.
  value?: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: BarChart2, text: 'Summarize my pipeline' },
  { icon: Activity, text: 'Get pipeline briefing', value: '/briefing ' },
  { icon: FileText, text: 'Draft a proposal for a new client' },
  { icon: Calendar, text: 'Which deals close this month?' },
  { icon: Search, text: 'Find contacts at a company' },
  { icon: UserCheck, text: 'Qualify this lead' },
  { icon: Phone, text: 'Log a call with a contact' },
];

interface EmptyStateProps {
  onSuggestion: (text: string) => void;
}

export function EmptyState({ onSuggestion }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <h2 className="text-xl font-semibold mb-2">Zipdev Sales</h2>
        <p className="text-sm text-neutral-500">
          Your AI sales co-pilot. Ask anything about your pipeline.
        </p>
      </motion.div>
      <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
        {SUGGESTIONS.map((s, i) => (
          <motion.button
            key={s.text}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            onClick={() => onSuggestion(s.value ?? s.text)}
            className="flex items-center gap-2 rounded-xl border p-3 text-sm text-left hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
          >
            <s.icon className="w-4 h-4 shrink-0 text-neutral-500" />
            <span>{s.text}</span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
