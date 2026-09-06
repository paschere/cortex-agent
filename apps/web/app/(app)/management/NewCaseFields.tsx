'use client';

import { VoiceDictation } from '@/components/chat/VoiceDictation';
import { CortexSignature } from '@/components/ui/cortex-signature';
import type { ManagementCase, ManagementCaseData } from '@/lib/management/shape';
import { CalendarDays, Check, ChevronDown, Users } from 'lucide-react';
import { useId, useState } from 'react';
import { Field, type Person, PersonOptions, Select } from './form-fields';

type TextKey = 'title' | 'objective' | 'successCriteria' | 'nextAction';
const prompts: { key: TextKey; label: string; hint: string; placeholder: string; max: number }[] = [
  {
    key: 'title',
    label: 'Asunto',
    hint: 'Un nombre corto para encontrarlo en la agenda.',
    placeholder: 'Ej. Renovar el contrato de transporte',
    max: 180,
  },
  {
    key: 'objective',
    label: 'Resultado que necesitamos',
    hint: 'Describe qué debe cambiar cuando este asunto esté resuelto.',
    placeholder:
      'Ej. Tener el contrato renovado antes de que venza, con el nuevo alcance acordado.',
    max: 2000,
  },
  {
    key: 'successCriteria',
    label: 'Cómo sabremos que se logró',
    hint: 'Algo concreto que podamos comprobar; la evidencia se añade después.',
    placeholder: 'Ej. Contrato firmado por ambas partes y copia archivada.',
    max: 2000,
  },
  {
    key: 'nextAction',
    label: 'Próximo paso concreto',
    hint: 'La primera acción que alguien puede hacer para avanzar.',
    placeholder: 'Ej. Pedir al proveedor la propuesta de renovación y confirmar las condiciones.',
    max: 1000,
  },
];

function SpokenField({
  prompt,
  value,
  onChange,
  disabled,
  dictating,
  onDictating,
}: {
  prompt: (typeof prompts)[number];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  dictating: TextKey | null;
  onDictating: (key: TextKey | null) => void;
}) {
  const id = useId();
  const listening = dictating === prompt.key;
  const common = {
    id,
    value,
    placeholder: prompt.placeholder,
    required: true,
    maxLength: prompt.max,
    'aria-describedby': `${id}-hint`,
    readOnly: listening,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };
  return (
    <div className="case-spoken-field">
      <div className="case-spoken-field__label">
        <label htmlFor={id}>{prompt.label}</label>
        <VoiceDictation
          hideUnsupported
          label="Dictar"
          ariaLabel={`Dictar ${prompt.label.toLowerCase()}`}
          disabled={disabled || (!!dictating && !listening) || value.length >= prompt.max}
          getBaseText={() => value}
          onText={(text) => onChange(text.slice(0, prompt.max))}
          onListeningChange={(active) => {
            if (active) onDictating(prompt.key);
            else if (listening) onDictating(null);
          }}
        />
      </div>
      {prompt.key === 'title' ? (
        <input {...common} className="case-title-input" />
      ) : (
        <textarea {...common} rows={3} />
      )}
      <p id={`${id}-hint`}>
        {value.length >= prompt.max
          ? `Llegaste al límite de ${prompt.max} caracteres.`
          : listening
            ? 'Escuchando. Termina el dictado para revisar el texto.'
            : prompt.hint}
      </p>
    </div>
  );
}

export function NewCaseFields({
  data,
  field,
  people,
  cases,
  pending,
  onDictating,
}: {
  data: ManagementCaseData;
  field: <K extends keyof ManagementCaseData>(key: K, value: ManagementCaseData[K]) => void;
  people: Person[];
  cases: ManagementCase[];
  pending: boolean;
  onDictating: (active: boolean) => void;
}) {
  const [dictating, setDictating] = useState<TextKey | null>(null);
  const person = people.find((p) => p.id === data.ownerId);
  const completed = prompts.filter((p) => data[p.key].trim()).length;
  const date = (value: string) =>
    value
      ? new Date(`${value}T12:00:00Z`).toLocaleDateString('es-CO', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : 'Por definir';
  const textField = (key: TextKey) => {
    const prompt = prompts.find((p) => p.key === key);
    return prompt ? (
      <SpokenField
        key={key}
        prompt={prompt}
        value={data[key]}
        onChange={(value) => field(key, value)}
        disabled={pending}
        dictating={dictating}
        onDictating={(next) => {
          setDictating(next);
          onDictating(!!next);
        }}
      />
    ) : null;
  };
  return (
    <div className="case-create-grid">
      <div className="case-create-main">
        <section className="case-form-section" aria-labelledby="case-purpose-title">
          <div className="case-section-heading">
            <h3 id="case-purpose-title">Empieza por el resultado.</h3>
            <p>
              Puedes escribir o dictar los textos. Revisa lo que quede escrito antes de guardar.
            </p>
          </div>
          {textField('title')}
          {textField('objective')}
          {textField('successCriteria')}
        </section>
        <section className="case-form-section" aria-labelledby="case-plan-title">
          <div className="case-section-heading">
            <h3 id="case-plan-title">Dale un siguiente paso.</h3>
            <p>Asigna la responsabilidad y define cuándo volver a mirarlo.</p>
          </div>
          {textField('nextAction')}
          <div className="grid gap-5 sm:grid-cols-2">
            <Select
              label="Responsable"
              value={data.ownerId ?? ''}
              onChange={(value) => field('ownerId', value || null)}
            >
              <PersonOptions people={people} />
            </Select>
            <Select
              label="Impacto declarado"
              value={data.impact}
              onChange={(value) => field('impact', value as ManagementCaseData['impact'])}
            >
              <option value="high">Alto · afecta un resultado importante</option>
              <option value="medium">Medio · requiere seguimiento</option>
              <option value="low">Bajo · puede esperar</option>
            </Select>
          </div>
          <div className="case-dates">
            <Field
              label="Plazo"
              type="date"
              value={data.dueOn}
              onChange={(value) => field('dueOn', value)}
              required
            />
            <Field
              label="Próxima revisión"
              type="date"
              value={data.nextReviewOn}
              onChange={(value) => field('nextReviewOn', value)}
              required
            />
          </div>
          <p className="case-field-note">
            El plazo es la fecha objetivo. La revisión es cuándo quieres comprobar el avance.
          </p>
          {data.nextReviewOn > data.dueOn && (
            <p className="case-date-notice">
              La revisión quedó después del plazo. Confirma si quieres revisar el avance antes.
            </p>
          )}
        </section>
        <details
          className="case-context"
          open={data.sourceUrl || data.dependsOn || data.blocker ? true : undefined}
        >
          <summary>
            <span>
              Contexto adicional <small>Opcional</small>
            </span>
            <ChevronDown size={17} aria-hidden="true" />
          </summary>
          <div className="space-y-5">
            <p className="case-field-note">
              Vincula la información que ayuda a entender el asunto.
            </p>
            <Field
              label="Enlace a la fuente o trabajo relacionado (opcional)"
              value={data.sourceUrl ?? ''}
              onChange={(value) => field('sourceUrl', value || null)}
            />
            <Select
              label="Depende de"
              value={data.dependsOn ?? ''}
              onChange={(value) => field('dependsOn', value || null)}
            >
              <option value="">Sin dependencia</option>
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.data.title}
                </option>
              ))}
            </Select>
            <Field
              label="Bloqueo o dato que falta"
              value={data.blocker}
              onChange={(value) => field('blocker', value)}
              multiline
            />
          </div>
        </details>
      </div>
      <aside className="case-preview" aria-label="Vista previa del asunto">
        <div className="case-preview__header">
          <CortexSignature />
          <span>Así quedará en la agenda</span>
        </div>
        <span className="case-preview__state">Por organizar</span>
        <h3>{data.title.trim() || 'Tu próximo asunto'}</h3>
        <p className="case-preview__objective">
          {data.objective.trim() || 'El resultado que quieres lograr aparecerá aquí.'}
        </p>
        <div className="case-preview__next">
          <span>Próximo paso</span>
          <p>{data.nextAction.trim() || 'Una acción concreta para empezar.'}</p>
        </div>
        <dl>
          <div>
            <dt>
              <Users size={14} aria-hidden="true" /> Responsable
            </dt>
            <dd>{person?.name || person?.email || 'Sin asignar'}</dd>
          </div>
          <div>
            <dt>
              <CalendarDays size={14} aria-hidden="true" /> Plazo
            </dt>
            <dd>{date(data.dueOn)}</dd>
          </div>
          <div>
            <dt>Próxima revisión</dt>
            <dd>{date(data.nextReviewOn)}</dd>
          </div>
        </dl>
        <div className="case-preview__readiness">
          <span>{completed} de 4 textos definidos</span>
          <div aria-hidden="true">
            {prompts.map((p) => (
              <i key={p.key} data-done={!!data[p.key].trim()} />
            ))}
          </div>
        </div>
        <p className="case-preview__privacy">
          <Check size={14} aria-hidden="true" /> Visible para la empresa al guardar.
        </p>
      </aside>
    </div>
  );
}
