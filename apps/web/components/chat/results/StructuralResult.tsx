'use client';

import { ChatMarkdown } from '../ChatMarkdown';
import { ResultGrid } from './ResultGrid';
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

  /*
   * LA MISMA REJILLA QUE LA CAPA DECLARADA, Y ESA ES TODA LA TESIS.
   *
   * Aquí había un `<table>` escrito a mano, casi igual al de `DeclaredTable`
   * pero no igual: otro relleno, la alineación decidida celda a celda en vez de
   * por columna, y un aviso de corte que la otra no tenía. Ninguna de esas
   * diferencias la decidió nadie. Lo que separa a esta capa de la declarada es
   * que aquí NADIE SABE QUÉ ES CADA COLUMNA — y eso se nota en lo que la
   * rejilla hace con lo que recibe, no en cómo la pinta: sin `kind` no hay
   * fechas formateadas y no hay ningún total, porque no se puede totalizar lo
   * que no se sabe qué es.
   *
   * `density="inline"` es lo único que cambia: esto vive dentro del chevron de
   * un paso, y ahí es evidencia y no la respuesta.
   */
  return (
    <div className="space-y-2">
      {view.note && <ToolProse text={view.note} />}
      <ResultGrid
        columns={view.columns.map((c) => ({ key: c, label: label(c) }))}
        rows={view.rows}
        density="inline"
      />
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
