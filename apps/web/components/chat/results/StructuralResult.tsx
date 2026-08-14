'use client';

import { clsx } from 'clsx';
import { ChatMarkdown } from '../ChatMarkdown';
import { type Structural, structuralView } from './registry';

/**
 * EL SUELO: lo que se lee de un resultado sin saber de qué herramienta viene.
 *
 * Sustituye al `<pre>` de JSON dentro del chevron de un paso. No asciende a
 * tarjeta y no debe hacerlo: `TaskRows` tiene razón en que una llamada es un
 * renglón y doce tarjetas son una pared. Lo único que cambia es que al
 * desplegar un paso se lee algo, en vez de un objeto en bruto.
 *
 * Cuando la forma no se reconoce, vuelve el JSON. Eso no es rendirse: es que
 * dibujar una tabla que se come la mitad de los datos es PEOR que el JSON,
 * porque el JSON al menos se ve entero y quien lo mira sabe que lo está
 * mirando.
 */
export function StructuralResult({ result }: { result: unknown }) {
  const view = structuralView(result);
  if (!view) return <RawJson value={result} />;
  return <Rendered view={view} />;
}

/**
 * LA FRASE DE UNA HERRAMIENTA ES MARKDOWN, Y SE ESTABA PINTANDO EN CRUDO.
 *
 * En pantalla se leía, literalmente, `**Vencimientos — próximos 30 días**` con
 * los asteriscos puestos, y los saltos de línea colapsados en un solo párrafo:
 * cuarenta renglones de muro donde había un informe con titulares, viñetas y
 * procedencias en cursiva. No era una decisión de diseño, era un `<p>` con una
 * cadena dentro.
 *
 * Y no es un caso raro: `NOTE_KEYS` recoge `guidance`, `summary`, `note`,
 * `message` y `markdown` — la última se llama así — y las herramientas de este
 * repositorio escriben ahí prosa con formato a propósito, porque es lo que el
 * modelo lee y lo que una persona acaba leyendo si despliega el paso.
 *
 * Se renderiza con `ChatMarkdown`, el mismo de las respuestas, para que un
 * informe no se vea de dos maneras distintas según dónde caiga. Lo único que
 * cambia es la escala: dentro de un paso desplegado, esto es evidencia y no la
 * respuesta, así que va un punto más pequeño y en tono apagado.
 */
function ToolProse({ text }: { text: string }) {
  return (
    <ChatMarkdown
      content={text}
      className="prose-p:text-xs prose-p:text-ink-muted prose-li:text-xs prose-li:text-ink-muted prose-headings:text-sm prose-headings:mt-2 prose-strong:text-ink prose-table:text-xs"
    />
  );
}

function Rendered({ view }: { view: NonNullable<Structural> }) {
  if (view.kind === 'note') {
    return <ToolProse text={view.text} />;
  }

  if (view.kind === 'fields') {
    return (
      <div className="space-y-2">
        {view.note && <ToolProse text={view.note} />}
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {view.entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-micro uppercase tracking-field text-ink-faint">{label(key)}</dt>
              <dd className="text-xs text-ink">{cell(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {view.note && <ToolProse text={view.note} />}
      {/* Su propio scroll horizontal: una tabla ancha dentro de una burbuja de
          chat no puede empujar la conversación entera de lado. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border">
              {view.columns.map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap px-2 py-1.5 text-left text-micro font-semibold uppercase tracking-field text-ink-faint"
                >
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr
                // Sin id fiable en una forma que no conocemos: el índice es la
                // única clave honesta, y la lista no se reordena.
                key={`${i}-${String(row[view.columns[0] ?? ''] ?? '')}`}
                className="border-b border-border/60 last:border-0"
              >
                {view.columns.map((c) => (
                  <td
                    key={c}
                    className={clsx(
                      'px-2 py-1.5 align-top text-ink',
                      typeof row[c] === 'number' && 'tabular-nums text-right',
                    )}
                  >
                    {cell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.rows.length === 50 && (
        // Nunca cortar en silencio. Ver cincuenta filas y creer que son todas
        // es peor que ver cincuenta y saber que hay más.
        <p className="text-micro text-ink-faint">
          Se muestran las primeras 50. Pídeme el resto si lo necesitas.
        </p>
      )}
    </div>
  );
}

/** `due_on` → `Due on`. No traduce: no hay diccionario para 134 herramientas. */
function label(key: string): string {
  const words = key.replaceAll(/[._-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cell(value: unknown) {
  if (value === null || value === undefined) {
    return <span className="text-ink-faint">—</span>;
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value);
}

function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="scroll-slim overflow-x-auto rounded-sm bg-surface-2 p-2 font-mono text-micro leading-relaxed text-ink-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
