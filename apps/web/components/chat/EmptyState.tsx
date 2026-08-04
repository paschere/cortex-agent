"use client";

import { motion } from "framer-motion";
import {
  BarChart2,
  FileText,
  Calendar,
  Search,
  UserCheck,
  Mail,
  Activity,
  Sparkles,
  Users,
  Calculator,
  AlarmClock,
  HeartHandshake,
} from "lucide-react";

interface Suggestion {
  icon: typeof BarChart2;
  text: string;
  /** Optional override sent to the input when clicked (e.g. prefill a slash command). */
  value?: string;
}

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

const SALES_SUGGESTIONS: Suggestion[] = [
  { icon: BarChart2, text: "Summarize my pipeline" },
  { icon: Activity, text: "Get a deal briefing", value: "/briefing " },
  { icon: FileText, text: "Draft a proposal for a new client" },
  { icon: Calendar, text: "Which deals close this month?" },
  { icon: Search, text: "Research a prospect on the web" },
  { icon: Mail, text: "Draft a follow-up email" },
  { icon: UserCheck, text: "Qualify this lead" },
];

// One suggestion per front (sales, recruiting, rates, HR, clients, routines) —
// the point of the empty state is to show Cortex's breadth in one glance.
const CORTEX_SUGGESTIONS: Suggestion[] = [
  { icon: BarChart2, text: "Summarize my pipeline and flag stuck deals" },
  { icon: Users, text: "Find candidates for a senior React role" },
  { icon: Calculator, text: "What would 2 senior QAs and a DevOps lead cost?" },
  { icon: HeartHandshake, text: "Prep me for my next client call" },
  {
    icon: AlarmClock,
    text: "Every Friday at 4, send each client their active-candidates report",
  },
  { icon: Mail, text: "Draft a follow-up email in my voice" },
];

const COPY: Record<
  string,
  { title: string; subtitle: string; suggestions: Suggestion[] }
> = {
  cortex: {
    title: "Cortex — your super-agent",
    subtitle:
      "It sells, it recruits, it runs HR, it takes care of clients — grounded in your live CRM, talent pool, and Knowledge Base. One goal in, a whole operation out.",
    suggestions: CORTEX_SUGGESTIONS,
  },
  sales: {
    title: "Cortex Sales co-pilot",
    subtitle:
      "Ask about your pipeline, draft proposals, research prospects, or send follow-ups — grounded in your live CRM and inbox.",
    suggestions: SALES_SUGGESTIONS,
  },
};

const DEFAULT_COPY = COPY.sales as (typeof COPY)[string];

export function EmptyState({
  agent,
  onSuggestion,
}: {
  agent?: AgentInfo;
  onSuggestion: (text: string) => void;
}) {
  const copy = (agent && COPY[agent.slug]) ?? {
    ...DEFAULT_COPY,
    title: agent?.name ?? DEFAULT_COPY.title,
    subtitle: agent?.greeting ?? DEFAULT_COPY.subtitle,
  };

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
        <h2 className="mt-5 text-xl font-extrabold tracking-tight text-ink">
          {copy.title}
        </h2>
        <p className="mt-1 max-w-sm text-[13px] text-ink-muted">
          {copy.subtitle}
        </p>
      </motion.div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {copy.suggestions.map((s, i) => (
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
