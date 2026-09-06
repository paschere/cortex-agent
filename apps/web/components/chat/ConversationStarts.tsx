'use client';
import { ArrowUpRight, FileSearch, ListChecks, Scale } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
const paths = [
  {
    id: 'understand',
    label: 'Entender',
    icon: FileSearch,
    title: 'Conecta los datos con una pregunta.',
    examples: [
      'Revisa la información disponible y dime qué necesita mi atención hoy.',
      'Quiero consultar un documento. Ayúdame a distinguir los hechos de lo que falta confirmar.',
    ],
  },
  {
    id: 'decide',
    label: 'Decidir',
    icon: Scale,
    title: 'Evalúa opciones antes de actuar.',
    examples: [
      'Ayúdame a tomar una decisión: compara las opciones, sus consecuencias y qué dato falta.',
      'Revisa las aprobaciones que esperan por mí y explícame qué implica cada una.',
    ],
  },
  {
    id: 'follow',
    label: 'Dar seguimiento',
    icon: ListChecks,
    title: 'De un pendiente a un resultado comprobable.',
    examples: [
      'Revisa los asuntos abiertos y dime cuáles están bloqueados o sin responsable.',
      'Quiero organizar un compromiso con responsable, fecha y evidencia de cierre.',
    ],
  },
];
export function ConversationStarts({ onCompose }: { onCompose: (text: string) => void }) {
  const [selected, setSelected] = useState(0);
  const path = paths[selected] ?? paths[0];
  if (!path) return null;
  return (
    <section className="conversation-starts" aria-label="Cómo trabajar con Cortex">
      <div className="conversation-starts__tabs">
        {paths.map((item, i) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={i === selected}
            onClick={() => setSelected(i)}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
      <p>{path.title}</p>
      <div className="conversation-starts__examples">
        {path.examples.map((text) => (
          <button key={text} type="button" onClick={() => onCompose(text)}>
            <span>{text}</span>
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
      <div className="conversation-starts__footer">
        <span>Elige una idea y edítala antes de enviar.</span>
        <Link href="/onboarding">Configurar mi empresa</Link>
      </div>
    </section>
  );
}
