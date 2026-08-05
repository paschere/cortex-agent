'use client';

import { AlarmClock, AudioLines, Brain, FileSearch, Network, Truck, Users } from 'lucide-react';

interface Suggestion {
  icon: typeof Truck;
  text: string;
}

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

/**
 * An empty screen is an invitation to act, so these are the jobs Cortex can
 * actually do today — call and meeting memory, the fleet and what the
 * registries say about it, routines that run unattended, and work split across
 * agents — written as the person would ask for them, not as feature names.
 */
const SUGGESTIONS: Suggestion[] = [
  { icon: AudioLines, text: '¿En qué quedamos en la última llamada con el cliente?' },
  { icon: Users, text: 'Resume la reunión de ayer y dime quién quedó con qué' },
  { icon: Truck, text: 'Consulta la placa ABC123 en el RUNT y en el SIMIT' },
  { icon: FileSearch, text: '¿A qué vehículos se les vencen papeles este mes?' },
  { icon: AlarmClock, text: 'Todos los lunes a las 8, mándame los documentos por vencer' },
  { icon: Network, text: 'Divide esto en pasos, repártelos entre los agentes y cuéntame' },
];

const CORTEX_COPY = {
  title: 'Pregúntale a Cortex',
  subtitle:
    'Lee tus llamadas, tu flota, tus rutinas y tu Brain Knowledge, y te dice de dónde salió cada respuesta.',
};

const COPY: Record<string, { title: string; subtitle: string }> = { cortex: CORTEX_COPY };

export function EmptyState({
  agent,
  onSuggestion,
}: {
  agent?: AgentInfo;
  onSuggestion: (text: string) => void;
}) {
  const copy = (agent && COPY[agent.slug]) ?? {
    title: agent?.name ?? CORTEX_COPY.title,
    subtitle: agent?.greeting ?? CORTEX_COPY.subtitle,
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
      <div className="animate-rise mb-7 flex flex-col items-center">
        <span className="grid h-11 w-11 place-items-center rounded-card bg-primary-soft text-primary shadow-card ring-1 ring-inset ring-primary/10">
          <Brain className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-lg font-bold tracking-tight text-ink">{copy.title}</h2>
        <p className="mt-1.5 max-w-md text-[13px] leading-snug text-ink-muted">{copy.subtitle}</p>
      </div>

      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.text}
            type="button"
            // CSS animation, not framer-motion: globals.css already neutralises
            // it under prefers-reduced-motion.
            className="animate-rise group flex items-start gap-2.5 rounded-card border border-border bg-surface p-3.5 text-left text-[13px] leading-snug text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:text-ink hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
            style={{ animationDelay: `${60 + i * 40}ms` }}
            onClick={() => onSuggestion(s.text)}
          >
            <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
