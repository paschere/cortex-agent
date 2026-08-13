'use client';

import type { FirstStep, Opener, OpenerTone, OpenersResponse } from '@/lib/chat-openers-shape';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  BarChart3,
  Brain,
  Building2,
  CalendarClock,
  CalendarDays,
  Car,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Mic,
  Plug,
  Send,
  Sparkles,
  Telescope,
  TriangleAlert,
  Upload,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';

/**
 * LA PRIMERA PANTALLA, SEMBRADA CON LO QUE ESTA EMPRESA TIENE.
 *
 * Antes había seis tarjetas escritas a mano que no miraban nada: le proponían
 * consultar el RUNT a un espacio sin ese servicio configurado y preguntar por
 * la última llamada a uno que nunca grabó una. Ahora las tarjetas nombran el
 * documento que subieron ayer, el cliente por su nombre y el vencimiento que
 * está más cerca — y sólo aparecen si la herramienta que las contesta se puede
 * ejecutar de verdad.
 *
 * Las reglas están en `lib/chat-openers-shape.ts` y las filas las junta
 * `/api/chat/openers`. Aquí sólo se dibuja. CERO llamadas al modelo: una
 * petición cacheada cinco minutos, y nada más.
 *
 * Al hacer clic la frase se ESCRIBE en el compositor, no se manda. La primera
 * pregunta de alguien merece poder retocarse antes de salir, y una tarjeta que
 * dispara un turno al primer clic es una tarjeta que da miedo tocar.
 */

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

const ICONS: Record<string, typeof Brain> = {
  AlarmClock,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarDays,
  Car,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Mic,
  Plug,
  Send,
  Sparkles,
  Telescope,
  Upload,
  Wallet,
};

function icon(name: string): typeof Brain {
  return ICONS[name] ?? Sparkles;
}

/** Los mismos cinco tonos de `globals.css`, nada inventado aquí. */
const TONE: Record<OpenerTone, string> = {
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  sky: 'text-sky',
  rose: 'text-rose',
};

const CORTEX_COPY = {
  title: 'Pregúntale a Cortex',
  subtitle:
    'Lee tus llamadas, tu flota, tus rutinas y tu Brain Knowledge, y te dice de dónde salió cada respuesta.',
};

const COPY: Record<string, { title: string; subtitle: string }> = { cortex: CORTEX_COPY };

/** Cinco minutos: lo que tarda en aparecer un documento subido en otra pestaña. */
const OPENERS_STALE_MS = 5 * 60 * 1000;

function OpenerCard({
  opener,
  index,
  onSuggestion,
}: {
  opener: Opener;
  index: number;
  onSuggestion: (text: string) => void;
}) {
  const Icon = icon(opener.icon);
  return (
    <button
      type="button"
      // CSS animation, not framer-motion: globals.css already neutralises it
      // under prefers-reduced-motion.
      className="animate-rise group flex items-start gap-2.5 rounded-card border border-border bg-surface p-3.5 text-left text-[13px] leading-snug text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:text-ink hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
      style={{ animationDelay: `${60 + index * 40}ms` }}
      onClick={() => onSuggestion(opener.text)}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE[opener.tone]}`} aria-hidden />
      <span className="min-w-0">
        <span className="block">{opener.text}</span>
        {opener.hint ? (
          // La procedencia se dibuja porque es la mitad del valor: una tarjeta
          // que nombra un documento tiene que decir que lo está nombrando, o
          // se lee como una frase de ejemplo más.
          <span className="mt-1 block truncate text-[11px] text-ink-faint">{opener.hint}</span>
        ) : null}
      </span>
    </button>
  );
}

function FirstStepCard({ step, index }: { step: FirstStep; index: number }) {
  const Icon = icon(step.icon);
  return (
    <Link
      href={step.href}
      className="animate-rise group flex items-start gap-2.5 rounded-card border border-border bg-surface p-3.5 text-left shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
      style={{ animationDelay: `${60 + index * 40}ms` }}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-snug text-ink">{step.label}</span>
        <span className="mt-1 block text-[12px] leading-snug text-ink-muted">{step.blurb}</span>
      </span>
    </Link>
  );
}

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

  const slug = agent?.slug ?? '';
  const openers = useQuery<OpenersResponse>({
    queryKey: ['chat-openers', slug],
    queryFn: async () => {
      const res = await fetch(`/api/chat/openers?agent=${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('openers');
      return (await res.json()) as OpenersResponse;
    },
    staleTime: OPENERS_STALE_MS,
    // Una pantalla de bienvenida no puede reintentar tres veces: o llega rápido
    // o no llega, y lo que se dibuja entretanto no cambia.
    retry: false,
    refetchOnWindowFocus: false,
  });

  const data = openers.data;
  const blank = data?.blank ?? false;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
      <div className="animate-rise mb-7 flex flex-col items-center">
        <span className="grid h-11 w-11 place-items-center rounded-card bg-primary-soft text-primary shadow-card ring-1 ring-inset ring-primary/10">
          <Brain className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-lg font-bold tracking-tight text-ink">
          {blank ? 'Todavía no hay nada que preguntarle' : copy.title}
        </h2>
        <p className="mt-1.5 max-w-md text-[13px] leading-snug text-ink-muted">
          {blank
            ? 'Cortex contesta con lo que tenga tu empresa adentro, y este espacio está recién creado. Empieza por aquí y la próxima vez esta pantalla te propone preguntas con tus propios documentos.'
            : copy.subtitle}
        </p>
      </div>

      {/*
        Un fallo de lectura NUNCA se dibuja como un espacio vacío. «No tienes
        documentos» y «no pude leer tus documentos» son dos frases distintas, y
        sólo una de las dos manda a alguien a subir de nuevo algo que ya está.
      */}
      {data?.notice || openers.isError ? (
        <p className="animate-rise mb-3 flex max-w-xl items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2 text-left text-[12px] leading-snug text-ink-muted">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
          <span>
            {data?.notice ??
              'No pude armar sugerencias con tus datos ahora mismo. Pregúntame igual, que el chat funciona.'}
          </span>
        </p>
      ) : null}

      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {blank
          ? (data?.firstSteps ?? []).map((step, i) => (
              <FirstStepCard key={step.id} step={step} index={i} />
            ))
          : (data?.openers ?? []).map((opener, i) => (
              <OpenerCard key={opener.id} opener={opener} index={i} onSuggestion={onSuggestion} />
            ))}
        {/*
          Mientras llega la respuesta no se dibujan tarjetas de relleno con
          texto falso: son seis frases que alguien va a leer, y leer una frase
          inventada y verla cambiar es peor que esperar dos décimas.
        */}
        {openers.isLoading
          ? [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-[62px] animate-pulse rounded-card border border-border bg-surface-2"
              />
            ))
          : null}
      </div>
    </div>
  );
}
