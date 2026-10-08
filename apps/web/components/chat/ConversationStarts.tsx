'use client';
import { AlarmClock, ArrowUpRight, Sparkles, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
/**
 * LAS IDEAS DE LA PRIMERA PANTALLA, ORIENTADAS AL PRIMER VALOR.
 *
 * Antes eran tres pestañas abstractas («Entender», «Decidir», «Dar
 * seguimiento») con frases que servían para cualquier empresa y para ninguna.
 * Un dueño que abre el chat por primera vez quiere ver una cifra suya o
 * quitarse una tarea de encima: por eso empiezan por conocer la empresa, siguen
 * por la plata y terminan en lo que Cortex puede hacer solo, cada vez.
 */
const paths = [
  {
    id: 'today',
    label: 'Mi día',
    icon: Sparkles,
    title: 'Lo que está pasando hoy en tu empresa.',
    examples: [
      '¿Qué tengo pendiente hoy?',
      '¿Qué sabes de mi empresa y qué te falta para ayudarme mejor?',
      '¿Qué mensajes o solicitudes siguen sin respuesta esta semana?',
      'Prepárame un resumen para empezar el día.',
    ],
  },
  {
    id: 'money',
    label: 'Plata',
    icon: Wallet,
    title: 'Cifras claras, sin abrir hojas de cálculo.',
    examples: [
      'Resume la plata de esta semana.',
      '¿Qué pagos y vencimientos tengo en los próximos 7 días?',
      '¿Quién me debe y desde hace cuánto?',
      'Redacta un recordatorio de pago cordial y muéstramelo antes de enviarlo.',
    ],
  },
  {
    id: 'build',
    label: 'Automatizar',
    icon: AlarmClock,
    title: 'Pídeselo una vez y queda andando.',
    examples: [
      'Crea una tabla para ',
      'Conecta una hoja de Google que ya uso.',
      'Cada lunes a las 8 a. m. mándame un resumen de lo que vence en la semana.',
      'Revisa lo que espera mi aprobación y explícame cada cosa en una línea.',
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
