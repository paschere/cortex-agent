'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import type { CustomToolDraft } from './custom-tools-api';

export function PrepareTool({
  onPrepared,
  onCancel,
}: { onPrepared: (draft: CustomToolDraft) => void; onCancel: () => void }) {
  const [apiUrl, setApiUrl] = useState('');
  const [purpose, setPurpose] = useState('');
  const [documentation, setDocumentation] = useState('');
  const [documentationUrl, setDocumentationUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    draft: CustomToolDraft | null;
    questions: string[];
    explanation: string;
  } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [clarifications, setClarifications] = useState('');
  const area = 'mt-2 w-full rounded-lg border border-border bg-surface p-3 text-sm text-ink';
  return (
    <section className="mt-5 space-y-5 border-t border-border pt-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
          API de tu empresa
        </p>
        <h3 className="mt-1 text-lg font-semibold">
          Explica la tarea. Cortex prepara la conexión.
        </h3>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Por ejemplo: consultar un pedido en tu ERP. Prepara una operación a la vez, revisa sus
          campos y pruébala antes de activarla para esta empresa.
        </p>
      </div>
      <form
        id="prepare-source-form"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setResult(null);
          setError('');
          setReviewed(false);
          try {
            const response = await fetch('/api/custom-tools/prepare', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiUrl,
                purpose,
                documentation,
                documentationUrl,
                clarifications,
              }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo preparar la herramienta.');
            setResult(data);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'La conexión falló. Inténtalo de nuevo.');
          } finally {
            setPending(false);
          }
        }}
      >
        <label className="block text-sm font-medium">
          1. ¿Qué quieres que haga Cortex?
          <textarea
            className={area}
            required
            minLength={10}
            maxLength={1500}
            disabled={pending}
            value={purpose}
            onChange={(e) => {
              setPurpose(e.target.value);
              setResult(null);
            }}
            placeholder="Consultar el estado de un pedido usando su número y explicar si tiene retrasos."
          />
        </label>
        <label htmlFor="prepare-api" className="block text-sm font-medium">
          2. Dirección de la API del sistema
          <Input
            className="mt-2"
            id="prepare-api"
            type="url"
            required
            disabled={pending}
            value={apiUrl}
            onChange={(e) => {
              setApiUrl(e.target.value);
              setResult(null);
            }}
            placeholder="https://api.miempresa.com/v1"
          />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <label htmlFor="prepare-docs" className="block text-sm font-medium">
            3. Documentación: enlace público
            <Input
              className="mt-2"
              id="prepare-docs"
              type="url"
              disabled={pending}
              value={documentationUrl}
              onChange={(e) => {
                setDocumentationUrl(e.target.value);
                setResult(null);
              }}
              placeholder="https://api.miempresa.com/openapi.json"
            />
            <span className="mt-2 block text-xs text-ink-muted">
              O pega el contenido a continuación. Enlaces con inicio de sesión o documentación
              cargada con JavaScript requieren copiar el texto.
            </span>
          </label>
          <label className="block text-sm font-medium">
            O cargar un archivo
            <input
              className="mt-2 block w-full text-xs"
              type="file"
              accept=".json,.yaml,.yml,.txt,.md"
              disabled={pending}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setResult(null);
                setError('');
                if (file.size > 50000) {
                  setError('Usa un archivo de hasta 50 KB con la operación que necesitas.');
                  return;
                }
                try {
                  setDocumentation(await file.text());
                } catch {
                  setError('No se pudo leer el archivo.');
                }
              }}
            />
            <span className="mt-2 block text-xs text-ink-muted">
              OpenAPI JSON/YAML, Markdown o texto · hasta 50 KB.
            </span>
          </label>
        </div>
        <label className="block text-sm font-medium">
          Documentación de la operación
          <textarea
            className={`${area} min-h-40 font-mono text-xs`}
            disabled={pending}
            maxLength={50000}
            value={documentation}
            onChange={(e) => {
              setDocumentation(e.target.value);
              setResult(null);
            }}
            placeholder="Pega endpoint, parámetros, autenticación y un ejemplo de respuesta sin datos privados."
          />
        </label>
        <p className="text-xs text-ink-muted">
          Este contenido se envía al modelo configurado para preparar el borrador. Introduce las
          credenciales únicamente en el formulario posterior. La documentación no se guarda en el
          cerebro.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={pending || (!documentationUrl && documentation.trim().length < 40)}
          >
            {pending ? 'Interpretando documentación…' : 'Preparar conexión'}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Volver
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm text-rose">
          {error}
        </p>
      )}
      {result && (
        <div
          className="space-y-3 rounded-lg border border-primary/25 bg-primary-soft p-4"
          aria-live="polite"
        >
          <h4 className="font-semibold">
            {result.draft ? result.draft.name : 'Falta información para prepararla'}
          </h4>
          <p className="text-sm text-ink-muted">{result.explanation}</p>
          {result.draft && (
            <>
              <p className="break-all font-mono text-xs">
                {result.draft.method} {result.draft.urlTemplate}
              </p>
              <p className="text-xs text-ink-muted">
                Se guardará desactivada y con aprobación requerida. En el siguiente paso completas
                autenticación, revisas parámetros y guardas; luego puedes probar y activar.
              </p>
            </>
          )}
          {result.questions.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          {result.questions.length > 0 && (
            <div className="space-y-2">
              <label className="block text-sm">
                Responde aquí lo que falta
                <textarea
                  className={area}
                  value={clarifications}
                  maxLength={3000}
                  onChange={(e) => setClarifications(e.target.value)}
                  placeholder="Escribe lo que sabes o pega la respuesta del proveedor."
                />
              </label>
              <Button
                type="submit"
                form="prepare-source-form"
                disabled={pending || clarifications.trim().length < 3}
              >
                Actualizar con mis respuestas
              </Button>
            </div>
          )}
          {result.draft && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                Revisé la operación y completaré los datos pendientes en el formulario.
              </label>
              <Button
                type="button"
                disabled={!reviewed}
                onClick={() => result.draft && onPrepared(result.draft)}
              >
                Revisar configuración y credenciales
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
