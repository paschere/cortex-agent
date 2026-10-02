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
    id: 'start',
    label: 'Empezar',
    icon: Sparkles,
    title: 'Lo primero: que Cortex conozca tu empresa.',
    examples: [
      '¿Qué sabes de mi empresa y qué te falta para ayudarme mejor?',
      'Te voy a pasar un Excel con mis clientes: organízalo en una tabla que pueda consultar.',
      '¿Qué clientes me escribieron esta semana y siguen sin respuesta?',
    ],
  },
  {
    id: 'money',
    label: 'Plata',
    icon: Wallet,
    title: 'Cartera, pagos y vencimientos, con cifras.',
    examples: [
      '¿Quién me debe más de 60 días y cuánto?',
      '¿Qué pagos y vencimientos tengo en los próximos 7 días?',
      'Redacta un recordatorio de pago cordial para el cliente que más me debe, y muéstramelo antes de enviarlo.',
    ],
  },
  {
    id: 'auto',
    label: 'Que lo haga solo',
    icon: AlarmClock,
    title: 'Pídeselo una vez y queda andando.',
    examples: [
      'Cada lunes a las 8 a. m. mándame un resumen de lo que vence en la semana.',
      'Avísame cuando una factura pase de 30 días sin pago.',
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
