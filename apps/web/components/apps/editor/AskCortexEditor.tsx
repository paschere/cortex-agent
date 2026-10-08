'use client';

import { clsx } from 'clsx';
import { useRef, useState } from 'react';
import { INPUT } from './shared';

/**
 * EL EDITOR DE «PEDIRLE ALGO A CORTEX» (automatizaciones).
 *
 * Una instrucción en texto, como se la dirías a una persona. Se pueden usar los
 * datos de la fila con {{campo}} (al escribir «{{» salen los campos de la tabla)
 * y se elige qué puede cambiar Cortex en ESA fila sin pedir aprobación. Los
 * ejemplos de abajo son sólo texto sugerido: se copian a la instrucción y se
 * adaptan; no hay lógica a la medida detrás.
 */

/**
 * Espejo de `ASK_ALLOWABLE_TOOLS` de packages/agent-tools (spec.ts). Se repite
 * aquí porque un componente de cliente no puede importar el barril del paquete.
 */
const ASK_ALLOWABLE_TOOLS = ['gdrive.upload_file', 'whatsapp.group_send'] as const;
const ASK_ALLOW_LABEL: Record<(typeof ASK_ALLOWABLE_TOOLS)[number], string> = {
  'gdrive.upload_file': 'Guardar archivos en una carpeta de Drive que ya existe',
  'whatsapp.group_send': 'Escribir en un grupo de WhatsApp habilitado',
};

export interface AskField {
  key: string;
  label: string;
}

export type WritesMode = 'legacy' | 'row' | 'fields';

export const ASK_EXAMPLES: Array<{ title: string; text: string }> = [
  {
    title: 'Seguir un vuelo',
    text: 'Busca en la web el estado del vuelo {{vuelo}} del {{fecha}} (flight status). Actualiza el estado del vuelo (Programado, En vuelo, Demorado, Aterrizó o Cancelado), la hora estimada de llegada y la hora real de llegada si ya aterrizó. Cita la fuente y la frase que lo respalda en la observación. Si no encuentras un dato claro, no cambies nada y escribe «sin dato».',
  },
  {
    title: 'Calcular un precio con las reglas del cerebro',
    text: 'Calcula el precio de esta atención según el documento «Reglas de precios» del cerebro: busca la sección del cliente {{cliente}}, aplica sus unidades y recargos con los datos de la fila y escribe el precio y el desglose línea por línea (cada multiplicación y la regla aplicada). Si falta un dato o la regla es ambigua, no escribas el precio: en el desglose di qué falta.',
  },
  {
    title: 'Preguntar en un grupo de WhatsApp',
    text: 'Pregunta en el grupo «Despachos» de WhatsApp, con un mensaje corto y amable, cuál es el número de vuelo de la guía {{guia}}. (Marca «Escribir en un grupo de WhatsApp habilitado».)',
  },
  {
    title: 'Capturar la respuesta del grupo',
    text: 'Lee los mensajes de las últimas 24 horas del grupo «Despachos» que respondan a la pregunta por la guía {{guia}} o la mencionen. Si alguien da claramente el número de vuelo (dos letras o dígitos y de 1 a 4 números, como AV204), escríbelo en el campo de vuelo con la cita del mensaje como fuente. Si hay dudas o dos respuestas distintas, no escribas nada y dilo.',
  },
  {
    title: 'Guardar los documentos en la carpeta de Drive',
    text: 'Busca en mi Drive la carpeta «Vuelos» > la subcarpeta que contenga {{vuelo}} > la que contenga {{guia}} (la empresa la crea a mano; no la crees). Si la encuentras, sube allí los archivos del campo de documentos y escribe en la fila el enlace de Drive; si no existe, escribe «Sin carpeta en Drive» y el motivo en observaciones. (Marca «Guardar archivos en una carpeta de Drive que ya existe».)',
  },
  {
    title: 'Resumir una novedad',
    text: 'Lee la fila y escribe en observaciones un resumen de una frase de la novedad. Si hay algo urgente, dilo al comienzo.',
  },
];

/** La palabra que se está escribiendo después de «{{» (sin cerrar), o null. */
export function openVariable(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('{{');
  if (at < 0 || before.indexOf('}}', at) >= 0) return null;
  const word = before.slice(at + 2);
  return /^[^{}\n]{0,30}$/.test(word) ? word.trim().toLowerCase() : null;
}

export function AskCortexEditor({
  instruction,
  writesMode,
  writesFields,
  allow = [],
  fields,
  hasRow,
  onChange,
}: {
  instruction: string;
  writesMode: WritesMode;
  writesFields: string[];
  /** Herramientas externas declaradas (`ask_cortex.allow`): corren sin aprobación. */
  allow?: string[];
  fields: AskField[];
  hasRow: boolean;
  onChange: (patch: {
    instruction?: string;
    writesMode?: WritesMode;
    writesFields?: string[];
    allow?: string[];
  }) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [typing, setTyping] = useState<string | null>(null);

  const insert = (key: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? instruction.length;
    const open = instruction.slice(0, at).lastIndexOf('{{');
    const closed =
      open >= 0 && instruction.indexOf('}}', open) >= 0 && instruction.indexOf('}}', open) < at;
    const start = open >= 0 && !closed ? open : at;
    const next = `${instruction.slice(0, start)}{{${key}}}${instruction.slice(at)}`;
    onChange({ instruction: next });
    setTyping(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + key.length + 4;
      el?.setSelectionRange(pos, pos);
    });
  };

  const suggestions =
    typing === null
      ? []
      : fields
          .filter(
            (f) => f.key.toLowerCase().includes(typing) || f.label.toLowerCase().includes(typing),
          )
          .slice(0, 8);
  const toggle = (key: string) =>
    onChange({
      writesFields: writesFields.includes(key)
        ? writesFields.filter((k) => k !== key)
        : [...writesFields, key],
    });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <textarea
          ref={ref}
          value={instruction}
          rows={6}
          maxLength={3000}
          placeholder="Dile a Cortex qué hacer, con tus palabras. Escribe «{{» para usar un dato de la fila."
          onChange={(e) => {
            onChange({ instruction: e.target.value });
            setTyping(openVariable(e.target.value, e.target.selectionStart));
          }}
          onKeyUp={(e) =>
            setTyping(openVariable(instruction, (e.target as HTMLTextAreaElement).selectionStart))
          }
          className="w-full resize-y rounded-card border border-border bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
        />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Campos de la fila">
            {suggestions.map((f) => (
              <button
                key={f.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(f.key)}
                className="rounded-pill border border-primary bg-primary-soft px-2.5 py-1 text-micro font-semibold text-primary-ink"
              >
                {f.label} · {`{{${f.key}}}`}
              </button>
            ))}
          </div>
        )}
        {fields.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-micro text-ink-muted">Insertar dato:</span>
            {fields.slice(0, 14).map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => insert(f.key)}
                className="rounded-pill border border-border px-2 py-0.5 text-micro text-ink-muted hover:border-primary"
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <p className="text-micro text-ink-muted">
          Cortex tiene la fila completa a la vista, puede buscar en la web, en el cerebro de la
          empresa (sólo lo que tú puedes ver) y en las tablas. Si no está seguro, no escribe y lo
          dice en el historial, con la fuente y la cita de lo que sí escribió.
        </p>
      </div>

      {hasRow && (
        <div className="space-y-1.5 rounded-card bg-surface-2 p-2.5">
          <p className="text-xs font-semibold text-ink">
            ¿Qué puede cambiar en esta fila sin pedirte permiso?
          </p>
          <select
            value={writesMode}
            onChange={(e) => onChange({ writesMode: e.target.value as WritesMode })}
            className={clsx(INPUT, 'w-full')}
          >
            <option value="legacy">
              Nada nuevo: lo que escriba pide aprobación (salvo la tabla)
            </option>
            <option value="fields">Sólo los campos que elija</option>
            <option value="row">Cualquier campo de esta fila</option>
          </select>
          {writesMode === 'fields' && (
            <div className="flex flex-wrap gap-1.5">
              {fields.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => toggle(f.key)}
                  className={clsx(
                    'rounded-pill border px-2.5 py-1 text-micro font-semibold',
                    writesFields.includes(f.key)
                      ? 'border-primary bg-primary-soft text-primary-ink'
                      : 'border-border text-ink-muted',
                  )}
                >
                  {writesFields.includes(f.key) ? '✓ ' : ''}
                  {f.label}
                </button>
              ))}
            </div>
          )}
          <p className="text-micro text-ink-muted">
            Escribir en otra fila, otra tabla o mandar un correo siempre queda pendiente de
            aprobación.
          </p>
        </div>
      )}

      <div className="space-y-1.5 rounded-card bg-surface-2 p-2.5">
        <p className="text-xs font-semibold text-ink">
          ¿Puede actuar fuera de Cortex sin pedirte permiso?
        </p>
        {ASK_ALLOWABLE_TOOLS.map((tool) => (
          <label key={tool} className="flex items-start gap-2 text-xs text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={allow.includes(tool)}
              onChange={(e) =>
                onChange({
                  allow: e.target.checked ? [...allow, tool] : allow.filter((t) => t !== tool),
                })
              }
            />
            <span>
              {ASK_ALLOW_LABEL[tool]}
              <span className="block text-micro text-ink-muted">
                {tool === 'gdrive.upload_file'
                  ? 'Necesita el permiso de escritura de Drive de quien creó la regla. Nunca crea carpetas y no duplica archivos.'
                  : 'Solo grupos con «Permitir mensajes de Cortex», con topes por hora y por día. El número no usa la API oficial: úsalo con poco volumen.'}
              </span>
            </span>
          </label>
        ))}
        <p className="text-micro text-ink-muted">
          Sin marcar, mandar un mensaje o subir un archivo queda pendiente de aprobación.
        </p>
      </div>

      <details className="text-xs text-ink">
        <summary className="cursor-pointer font-semibold text-primary">
          Ejemplos de instrucciones
        </summary>
        <div className="mt-1.5 space-y-1.5">
          {ASK_EXAMPLES.map((ex) => (
            <div key={ex.title} className="rounded-card border border-border p-2">
              <p className="font-semibold">{ex.title}</p>
              <p className="text-ink-muted">{ex.text}</p>
              <button
                type="button"
                className="mt-1 text-micro font-semibold text-primary"
                onClick={() => onChange({ instruction: ex.text })}
              >
                Usar este texto
              </button>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
