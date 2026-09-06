'use client';

import { ArrowUpRight, Check, FileText } from 'lucide-react';
import { useState } from 'react';

const examples = [
  {
    label: 'Gerencia',
    question: '¿Qué necesita mi atención hoy?',
    answer:
      'La renovación del contrato necesita una decisión. La propuesta está preparada; falta que confirmes el alcance antes de enviarla.',
    source: 'Contrato de servicio · cláusula de renovación',
    rows: [
      ['Revisar el alcance', 'Tu decisión'],
      ['Preparar la propuesta', 'Borrador listo'],
      ['Enviar al cliente', 'Pendiente de aprobación'],
    ],
  },
  {
    label: 'Feed',
    question: 'Compara esta hoja con la propuesta que te pasé.',
    answer:
      'Puedo usar estos archivos para esta consulta. Tú decides después si el resultado debe formar parte del conocimiento de la empresa.',
    source: 'Presupuesto.xlsx + Propuesta.pdf · archivos de esta consulta',
    rows: [
      ['Usar los archivos', 'En esta consulta'],
      ['Revisar las diferencias', 'Con sus fuentes'],
      ['Guardar en el cerebro', 'Tú decides'],
    ],
  },
  {
    label: 'Trámites',
    question: 'Te voy a enseñar cómo consultamos el certificado.',
    answer:
      'Abre el portal en el navegador de Cortex con tu perfil. Haz el recorrido y explica los pasos; al terminar podrás revisar la propuesta y probarla.',
    source: 'Navegador de Cortex · perfil personal',
    rows: [
      ['Entrar al portal', 'Tu perfil'],
      ['Mostrar y explicar', 'Pasos del proceso'],
      ['Revisar y probar', 'Antes de repetir'],
    ],
  },
] as const;

export function MissionPreview() {
  const [selected, setSelected] = useState(0);
  const example = examples[selected] ?? examples[0];
  return (
    <div className="mission">
      <div className="mission__bar">
        <span className="mission__lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>Cortex / Tu espacio de trabajo</span>
        <span className="mission__example">Ejemplo ilustrativo</span>
      </div>
      <div className="mission__body">
        <fieldset className="mission__nav" aria-label="Explorar ejemplos de Cortex">
          {examples.map((item, index) => (
            <button
              type="button"
              key={item.label}
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {item.label}
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ))}
        </fieldset>
        <div className="mission__conversation" aria-live="polite">
          <p className="mission__question">{example.question}</p>
          <div className="mission__answer">
            <span className="mission__author">Cortex</span>
            <p>{example.answer}</p>
            <span className="mission__source">
              <FileText size={14} aria-hidden="true" />
              {example.source}
            </span>
          </div>
        </div>
        <div className="mission__activity">
          <h3>El siguiente paso, claro.</h3>
          {example.rows.map(([name, status], index) => (
            <div key={name}>
              <span className="mission__step">
                {index === 1 ? <Check size={13} aria-hidden="true" /> : index + 1}
              </span>
              <p>
                {name}
                <small>{status}</small>
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
