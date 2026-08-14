'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  Boxes,
  ChevronDown,
  CircleCheck,
  FlaskConical,
  Plus,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  type CustomToolAuthType,
  type CustomToolBodyEncoding,
  type CustomToolDraft,
  type CustomToolField,
  type CustomToolFieldType,
  type CustomToolMethod,
  type CustomToolTestResponse,
  type CustomToolView,
  EMPTY_DRAFT,
  EMPTY_FIELD,
  METHODS,
  deleteCustomTool,
  describeDescriptionQuality,
  draftProblems,
  isWriteMethod,
  loadCustomTools,
  runCustomToolTest,
  saveCustomTool,
  slugify,
  toDraft,
} from './custom-tools-api';

/**
 * The tools a company writes for itself: a name, a description, one HTTP call
 * to their own API, and the fields Cortex has to fill in before making it.
 *
 * THE FORM IS THE PRODUCT HERE. Everything it asks for is technical, and
 * nobody who fills it in is. So it guides: each field says what it is for in
 * the words of the person typing, the rarely-needed half is folded away behind
 * "Opciones avanzadas", and the description — the ONE thing the model reads
 * when deciding whether to pick this tool — gets the most room, its own tinted
 * box and a live note on whether it is saying enough. That field is the whole
 * difference between a tool that gets used and one that never gets chosen.
 *
 * Server contract: apps/web/app/api/custom-tools/**. The shapes are mirrored in
 * ./custom-tools-api.ts because `@/lib/custom-tools` is server-only.
 */

const AUTH_LABEL: Record<CustomToolAuthType, string> = {
  none: 'Ninguna — la API es abierta',
  bearer: 'Un token (va como Authorization: Bearer)',
  header: 'Una llave en una cabecera',
  basic: 'Usuario y contraseña',
};

const FIELD_TYPE_LABEL: Record<CustomToolFieldType, string> = {
  string: 'Texto',
  number: 'Número',
  integer: 'Número entero',
  boolean: 'Sí o no',
  string_array: 'Lista de textos',
};

const BODY_LABEL: Record<CustomToolBodyEncoding, string> = {
  none: 'Sin cuerpo',
  json: 'JSON',
  form: 'Formulario',
};

const TEXTAREA_CLASS =
  'w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 motion-reduce:transition-none';

const SELECT_CLASS =
  'rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10';

const CHECKBOX_CLASS = 'h-3.5 w-3.5 rounded-[4px] border-border text-primary';

const HELP = 'mt-0.5 text-micro leading-relaxed text-ink-faint';
const LABEL = 'block text-xs font-semibold text-ink';

export function CustomTools() {
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<CustomToolView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [atCapacity, setAtCapacity] = useState(false);
  const [maxTools, setMaxTools] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; draft: CustomToolDraft } | null>(null);
  const [openTester, setOpenTester] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const state = await loadCustomTools(signal);
    if (signal?.aborted) return;
    setTools(state.tools);
    setCanManage(state.canManage);
    setAtCapacity(state.atCapacity);
    setMaxTools(state.maxTools);
    setLoadError(state.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function remove(tool: CustomToolView) {
    const res = await deleteCustomTool(tool.id);
    if (res.ok) setTools((prev) => prev.filter((t) => t.id !== tool.id));
    else setLoadError(res.error ?? 'No se pudo borrar.');
  }

  function startCreate() {
    setNotice(null);
    setEditing({ draft: { ...EMPTY_DRAFT } });
  }

  return (
    <Panel className="p-4" id="herramientas-propias">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
            <Boxes className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink">Herramientas propias</h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
              Conecta la API de tu empresa sin escribir código: le pones nombre, explicas para qué
              sirve, y Cortex la usa cuando haga falta igual que cualquier otra herramienta. Corren
              con las mismas reglas: quedan en la auditoría y respetan los permisos de cada equipo.
            </p>
          </div>
        </div>
        {canManage && !editing && (
          <Button type="button" onClick={startCreate} disabled={atCapacity}>
            <Plus className="h-4 w-4" />
            Crear herramienta
          </Button>
        )}
      </div>

      {loading && <p className="mt-3 text-xs text-ink-faint">Cargando…</p>}

      {atCapacity && canManage && (
        <p className="mt-3 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-xs font-semibold text-amber">
          Llegaste al máximo de <span className="tabular">{maxTools}</span> herramientas propias.
          Borra una para poder crear otra.
        </p>
      )}

      {loadError && (
        <p className="mt-3 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs font-semibold text-rose">
          {loadError}
        </p>
      )}

      {notice && (
        <p className="mt-3 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-xs leading-relaxed text-amber">
          {notice}
        </p>
      )}

      {!loading && !editing && tools.length === 0 && !loadError && (
        <div className="mt-3 rounded-card border border-dashed border-border-strong bg-surface-2 p-6 text-center">
          <p className="text-sm font-semibold text-ink">Todavía no hay ninguna</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
            Sirven para lo que solo existe en tu empresa: consultar el inventario, mirar el estado
            de un pedido, crear una orden. Describes la llamada una sola vez y queda disponible para
            todo el mundo.
          </p>
          {canManage ? (
            <Button type="button" className="mt-4" onClick={startCreate}>
              <Plus className="h-4 w-4" />
              Crear la primera
            </Button>
          ) : (
            <p className="mt-3 text-micro text-ink-faint">
              Solo un administrador puede crearlas: quien define una puede consultar cualquier cosa
              que la red de Cortex alcance.
            </p>
          )}
        </div>
      )}

      {editing && (
        <CustomToolForm
          key={editing.id ?? 'new'}
          initial={editing.draft}
          editingId={editing.id}
          onCancel={() => setEditing(null)}
          onSaved={(tool, warning) => {
            setTools((prev) => {
              const rest = prev.filter((t) => t.id !== tool.id);
              return [...rest, tool].sort((a, b) => a.name.localeCompare(b.name, 'es'));
            });
            setEditing(null);
            setNotice(warning);
          }}
        />
      )}

      {!loading && tools.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {tools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              canManage={canManage}
              testerOpen={openTester === tool.id}
              onToggleTester={() => setOpenTester(openTester === tool.id ? null : tool.id)}
              onEdit={() => {
                setNotice(null);
                setEditing({ id: tool.id, draft: toDraft(tool) });
              }}
              onDelete={() => void remove(tool)}
              onChanged={(next) => setTools((p) => p.map((t) => (t.id === next.id ? next : t)))}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One saved tool
// ---------------------------------------------------------------------------

function ToolCard({
  tool,
  canManage,
  testerOpen,
  onToggleTester,
  onEdit,
  onDelete,
  onChanged,
}: {
  tool: CustomToolView;
  canManage: boolean;
  testerOpen: boolean;
  onToggleTester: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: (tool: CustomToolView) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    const res = await saveCustomTool({ ...toDraft(tool), enabled }, tool.id);
    setBusy(false);
    if (res.ok) onChanged(res.tool);
  }

  return (
    <div className="rounded-card border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink">{tool.name}</span>
            <code className="tabular text-micro text-ink-faint">{tool.toolId}</code>
            {!tool.enabled && (
              <span className="rounded-pill border border-border bg-surface px-2 py-0.5 text-micro font-semibold text-ink-muted">
                Apagada
              </span>
            )}
            {tool.requiresConfirmation && (
              <span className="inline-flex items-center gap-1 rounded-pill border border-amber/30 bg-amber-soft px-2 py-0.5 text-micro font-semibold text-amber">
                <ShieldAlert className="h-3 w-3" />
                Pide confirmación
              </span>
            )}
            {tool.lastError && (
              <span className="inline-flex items-center gap-1 rounded-pill border border-rose/30 bg-rose-soft px-2 py-0.5 text-micro font-semibold text-rose">
                <TriangleAlert className="h-3 w-3" />
                Falló la última prueba
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-ink-muted">{tool.description}</p>
          {canManage && tool.urlTemplate && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
              <span className="tabular font-semibold text-ink-muted">{tool.method}</span>
              <span className="tabular break-all">{tool.urlTemplate}</span>
              {tool.authType && tool.authType !== 'none' && (
                <span>· {tool.authConfigured ? 'con credencial guardada' : 'sin credencial'}</span>
              )}
            </p>
          )}
          {canManage && tool.lastError && (
            <p className="mt-1 text-micro leading-snug text-rose">{tool.lastError}</p>
          )}
        </div>

        {canManage && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button type="button" variant="outline" onClick={onToggleTester}>
              <FlaskConical className="h-4 w-4" />
              Probar
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void setEnabled(!tool.enabled)}
            >
              {tool.enabled ? 'Apagar' : 'Encender'}
            </Button>
            <Button type="button" variant="ghost" onClick={onEdit}>
              Editar
            </Button>
            {confirmDelete ? (
              <>
                <Button type="button" variant="danger" onClick={onDelete}>
                  Borrar de verdad
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label={`Borrar ${tool.name}`}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      {testerOpen && canManage && <Tester tool={tool} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Does this actually work?"
// ---------------------------------------------------------------------------

function Tester({ tool }: { tool: CustomToolView }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CustomToolTestResponse | null>(null);
  const fields = tool.fields ?? [];

  async function run() {
    setRunning(true);
    setResult(null);
    const input: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name] ?? '';
      if (raw === '' && !field.required) continue;
      if (field.type === 'number' || field.type === 'integer') input[field.name] = Number(raw);
      else if (field.type === 'boolean') input[field.name] = raw === 'true';
      else if (field.type === 'string_array') {
        input[field.name] = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else input[field.name] = raw;
    }
    setResult(await runCustomToolTest(tool.id, input));
    setRunning(false);
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-xs font-semibold text-ink">Probar la llamada</p>
      <p className={HELP}>
        Llama a tu API de verdad, por el mismo camino que usaría Cortex. Vas a ver qué se envió, qué
        respondió y con qué se quedaría el modelo. La llave no se muestra nunca.
      </p>

      {fields.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.name} className="min-w-0" htmlFor={`test-${tool.id}-${field.name}`}>
              <span className="field-label">
                {field.name}
                {field.required ? ' *' : ''}
              </span>
              {field.type === 'boolean' ? (
                <select
                  id={`test-${tool.id}-${field.name}`}
                  value={values[field.name] ?? 'false'}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  className={clsx(SELECT_CLASS, 'mt-1 w-full')}
                >
                  <option value="true">Sí</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <Input
                  id={`test-${tool.id}-${field.name}`}
                  className="mt-1"
                  value={values[field.name] ?? ''}
                  placeholder={
                    field.type === 'string_array'
                      ? 'Separa los valores con comas'
                      : field.description || field.name
                  }
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}

      <Button type="button" className="mt-3" onClick={() => void run()} disabled={running}>
        <FlaskConical className="h-4 w-4" />
        {running ? 'Llamando…' : 'Correr la prueba'}
      </Button>

      {result && <TestResult result={result} />}
    </div>
  );
}

function TestResult({ result }: { result: CustomToolTestResponse }) {
  return (
    <div
      className={clsx(
        'mt-3 rounded-card border p-3',
        result.ok ? 'border-emerald/30 bg-emerald-soft' : 'border-rose/30 bg-rose-soft',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {result.ok ? (
          <CircleCheck className="h-4 w-4 text-emerald" />
        ) : (
          <TriangleAlert className="h-4 w-4 text-rose" />
        )}
        <span
          className={clsx('text-xs font-semibold', result.ok ? 'text-emerald' : 'text-rose')}
        >
          {result.ok ? 'Respondió bien' : 'No funcionó'}
        </span>
        {result.response && (
          <span className="tabular text-micro text-ink-muted">
            HTTP {result.response.status} {result.response.statusText}
          </span>
        )}
        {result.elapsedMs != null && (
          <span className="tabular text-micro text-ink-muted">{result.elapsedMs} ms</span>
        )}
      </div>

      {result.error && <p className="mt-1 text-micro leading-snug text-rose">{result.error}</p>}
      {result.problems?.map((p) => (
        <p key={p} className="mt-1 text-micro leading-snug text-rose">
          {p}
        </p>
      ))}
      {result.modelResult?.message && (
        <p className="mt-1 text-micro leading-snug text-ink-muted">
          Lo que le llegaría al modelo: {result.modelResult.message}
        </p>
      )}

      {result.request && (
        <details className="mt-2">
          <summary className="cursor-pointer text-micro font-semibold text-ink-muted">
            Qué se envió
          </summary>
          <pre className="tabular mt-1 max-h-40 overflow-auto rounded-sm border border-border bg-surface p-2 text-micro leading-relaxed text-ink-muted">
            {`${result.request.method} ${result.request.url}\n${Object.entries(
              result.request.headers,
            )
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}${result.request.body ? `\n\n${result.request.body}` : ''}`}
          </pre>
          {result.chain && result.chain.length > 1 && (
            <p className="mt-1 text-micro text-ink-faint">
              Redirecciones: {result.chain.join(' → ')}
            </p>
          )}
        </details>
      )}

      {result.response && (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-micro font-semibold text-ink-muted">
            Qué respondió{result.response.truncated ? ' (recortado)' : ''}
          </summary>
          <pre className="tabular mt-1 max-h-48 overflow-auto rounded-sm border border-border bg-surface p-2 text-micro leading-relaxed text-ink-muted">
            {result.response.body || '(vacío)'}
          </pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function CustomToolForm({
  initial,
  editingId,
  onCancel,
  onSaved,
}: {
  initial: CustomToolDraft;
  editingId?: string;
  onCancel: () => void;
  onSaved: (tool: CustomToolView, warning: string | null) => void;
}) {
  const [draft, setDraft] = useState<CustomToolDraft>(initial);
  // The slug follows the name until somebody edits it by hand; after that the
  // name is theirs to change without silently renaming the tool's id.
  const [slugTouched, setSlugTouched] = useState(Boolean(editingId));
  const [advanced, setAdvanced] = useState(false);
  const [bodyText, setBodyText] = useState(() =>
    initial.bodyTemplate === undefined ? '' : JSON.stringify(initial.bodyTemplate, null, 2),
  );
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const quality = describeDescriptionQuality(draft.description);
  const writes = isWriteMethod(draft.method);
  const gated = draft.requiresConfirmation ?? writes;

  function patch(next: Partial<CustomToolDraft>) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function setName(name: string) {
    setDraft((d) => ({ ...d, name, ...(slugTouched ? {} : { slug: slugify(name) }) }));
  }

  function patchField(index: number, next: Partial<CustomToolField>) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, ...next } : f)),
    }));
  }

  function setBody(text: string) {
    setBodyText(text);
    if (!text.trim()) {
      setBodyError(null);
      patch({ bodyTemplate: undefined });
      return;
    }
    try {
      patch({ bodyTemplate: JSON.parse(text) });
      setBodyError(null);
    } catch {
      setBodyError('Todavía no es JSON válido. Revisa comillas y comas.');
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = draftProblems(draft);
    if (bodyError) found.push(bodyError);
    setProblems(found);
    setSaveError(null);
    if (found.length > 0) return;

    setSaving(true);
    const res = await saveCustomTool(draft, editingId);
    setSaving(false);
    if (res.ok) onSaved(res.tool, res.warning);
    else {
      setSaveError(res.error);
      setProblems(res.problems);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-card border border-border bg-surface-2 p-4"
      aria-label={editingId ? 'Editar herramienta propia' : 'Crear herramienta propia'}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-ink">
            {editingId ? 'Editar herramienta' : 'Nueva herramienta'}
          </h3>
          <p className={HELP}>
            Le vas a describir a Cortex una llamada a la API de tu empresa. Son cuatro cosas: cómo
            se llama, para qué sirve, a dónde llama y qué datos necesita.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cerrar el formulario"
          className="rounded-pill p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink motion-reduce:transition-none"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 1 — Name */}
      <div className="mt-4">
        <label className={LABEL} htmlFor="ct-name">
          ¿Cómo se llama?
        </label>
        <p className={HELP}>
          Un nombre corto, como se lo dirías a un compañero: «Consultar inventario», «Estado del
          pedido».
        </p>
        <Input
          id="ct-name"
          className="mt-1.5"
          value={draft.name}
          maxLength={80}
          placeholder="Consultar inventario"
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-micro text-ink-faint">
          Queda registrada como{' '}
          <code className="tabular text-ink-muted">custom.{draft.slug || '…'}</code>
        </p>
      </div>

      {/* 2 — Description. The field that decides everything. */}
      <div className="mt-4 rounded-card border border-primary/20 bg-primary-soft p-3">
        <label className={LABEL} htmlFor="ct-description">
          ¿Para qué sirve?
        </label>
        <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">Esto es lo único que Cortex lee</span> cuando
          decide si esta herramienta es la indicada para lo que le pidieron. Si no queda claro
          cuándo usarla, no la va a escoger nunca. Escribe en qué situación conviene, qué le tienes
          que dar y qué devuelve.
        </p>
        <textarea
          id="ct-description"
          rows={4}
          className={clsx(TEXTAREA_CLASS, 'mt-2')}
          value={draft.description}
          maxLength={1000}
          placeholder="Consulta cuántas unidades hay disponibles de un producto en bodega, por código SKU. Úsala cuando alguien pregunte por existencias, disponibilidad o si algo está agotado. Devuelve la cantidad disponible y en qué bodega está."
          onChange={(e) => patch({ description: e.target.value })}
        />
        <p
          className={clsx(
            'mt-1 text-micro',
            quality.tone === 'emerald' && 'text-emerald',
            quality.tone === 'amber' && 'text-amber',
            quality.tone === 'faint' && 'text-ink-faint',
          )}
        >
          {quality.text}
        </p>
      </div>

      {/* 3 — The call */}
      <div className="mt-4">
        <span className={LABEL}>¿A dónde llama?</span>
        <p className={HELP}>
          La dirección de tu API. Tiene que empezar por https:// y el dominio no puede cambiar. Para
          meter un dato adentro, escríbelo entre llaves dobles:{' '}
          <code className="tabular text-ink-muted">
            https://api.tuempresa.com/inventario/{'{{sku}}'}
          </code>
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <select
            aria-label="Método HTTP"
            value={draft.method}
            onChange={(e) => patch({ method: e.target.value as CustomToolMethod })}
            className={clsx(SELECT_CLASS, 'tabular')}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <Input
            className="tabular min-w-[240px] flex-1"
            value={draft.urlTemplate}
            placeholder="https://api.tuempresa.com/inventario/{{sku}}"
            onChange={(e) => patch({ urlTemplate: e.target.value })}
            aria-label="Dirección de la API"
          />
        </div>
      </div>

      {/* 4 — Fields */}
      <div className="mt-4">
        <span className={LABEL}>¿Qué datos necesita?</span>
        <p className={HELP}>
          Lo que Cortex tiene que averiguar antes de llamar. La descripción de cada dato también la
          lee el modelo, así que dile de dónde sale y cómo se ve.
        </p>

        {draft.fields.length === 0 && (
          <p className="mt-2 rounded-sm border border-dashed border-border-strong bg-surface px-3 py-2 text-micro text-ink-faint">
            Ninguno todavía. Si tu API no necesita nada, déjalo así.
          </p>
        )}

        <div className="mt-2 flex flex-col gap-2">
          {draft.fields.map((field, i) => (
            // Positional key: a name-based key would remount the input on every
            // keystroke and lose the caret.
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <div key={i} className="rounded-sm border border-border bg-surface p-2.5">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[140px] flex-1" htmlFor={`ct-field-${i}-name`}>
                  <span className="field-label">Nombre del dato</span>
                  <Input
                    id={`ct-field-${i}-name`}
                    className="tabular mt-1"
                    value={field.name}
                    placeholder="sku"
                    onChange={(e) => patchField(i, { name: e.target.value })}
                  />
                </label>
                <label>
                  <span className="field-label">Tipo</span>
                  <select
                    value={field.type}
                    onChange={(e) => patchField(i, { type: e.target.value as CustomToolFieldType })}
                    className={clsx(SELECT_CLASS, 'mt-1 block')}
                  >
                    {(Object.keys(FIELD_TYPE_LABEL) as CustomToolFieldType[]).map((k) => (
                      <option key={k} value={k}>
                        {FIELD_TYPE_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 pb-2.5 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => patchField(i, { required: e.target.checked })}
                    className={CHECKBOX_CLASS}
                  />
                  Obligatorio
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))
                  }
                  aria-label={`Quitar el dato ${field.name || i + 1}`}
                  className="ml-auto mb-1.5 rounded-pill p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-rose motion-reduce:transition-none"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <label className="mt-2 block" htmlFor={`ct-field-${i}-desc`}>
                <span className="field-label">Qué va acá</span>
                <Input
                  id={`ct-field-${i}-desc`}
                  className="mt-1"
                  value={field.description}
                  maxLength={300}
                  placeholder="El código SKU del producto, como aparece en la factura. Ej: ABC-123"
                  onChange={(e) => patchField(i, { description: e.target.value })}
                />
              </label>
              {field.type === 'string' && (
                <label className="mt-2 block" htmlFor={`ct-field-${i}-enum`}>
                  <span className="field-label">Opciones fijas (opcional, separadas por coma)</span>
                  <Input
                    id={`ct-field-${i}-enum`}
                    className="tabular mt-1"
                    value={(field.enum ?? []).join(', ')}
                    placeholder="pendiente, despachado, entregado"
                    onChange={(e) =>
                      patchField(i, {
                        enum: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <span className="mt-0.5 block text-micro text-ink-faint">
                    Si solo hay unos valores posibles, ponlos: el modelo no podrá inventarse uno que
                    tu sistema no conoce.
                  </span>
                </label>
              )}
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          className="mt-2"
          onClick={() => setDraft((d) => ({ ...d, fields: [...d.fields, { ...EMPTY_FIELD }] }))}
        >
          <Plus className="h-4 w-4" />
          Agregar un dato
        </Button>
      </div>

      {/* 5 — Body, only where it can exist */}
      {draft.method !== 'GET' && (
        <div className="mt-4">
          <span className={LABEL}>¿Qué le manda en el cuerpo?</span>
          <p className={HELP}>
            Lo que va dentro de la petición. Usa las mismas llaves dobles para meter un dato:{' '}
            <code className="tabular text-ink-muted">{'{"sku": "{{sku}}"}'}</code>
          </p>
          <select
            aria-label="Formato del cuerpo"
            value={draft.bodyEncoding}
            onChange={(e) => patch({ bodyEncoding: e.target.value as CustomToolBodyEncoding })}
            className={clsx(SELECT_CLASS, 'mt-1.5')}
          >
            {(Object.keys(BODY_LABEL) as CustomToolBodyEncoding[]).map((k) => (
              <option key={k} value={k}>
                {BODY_LABEL[k]}
              </option>
            ))}
          </select>
          {draft.bodyEncoding !== 'none' && (
            <>
              <textarea
                rows={4}
                aria-label="Contenido del cuerpo"
                className={clsx(TEXTAREA_CLASS, 'tabular mt-2')}
                value={bodyText}
                placeholder={'{\n  "sku": "{{sku}}",\n  "cantidad": "{{cantidad}}"\n}'}
                onChange={(e) => setBody(e.target.value)}
              />
              {bodyError && (
                <p className="mt-1 text-micro font-semibold text-rose">{bodyError}</p>
              )}
            </>
          )}
        </div>
      )}

      {/* 6 — Auth */}
      <div className="mt-4">
        <label className={LABEL} htmlFor="ct-auth">
          ¿Cómo entra Cortex?
        </label>
        <p className={HELP}>
          Si tu API pide una llave, un token o una contraseña, ponlo acá. Se guarda cifrado y no se
          vuelve a mostrar, ni siquiera al probar.
        </p>
        <select
          id="ct-auth"
          value={draft.authType}
          onChange={(e) => patch({ authType: e.target.value as CustomToolAuthType })}
          className={clsx(SELECT_CLASS, 'mt-1.5 w-full sm:w-auto')}
        >
          {(Object.keys(AUTH_LABEL) as CustomToolAuthType[]).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABEL[k]}
            </option>
          ))}
        </select>

        {draft.authType !== 'none' && (
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.authType === 'header' && (
              <label className="min-w-[160px]" htmlFor="ct-auth-header">
                <span className="field-label">Nombre de la cabecera</span>
                <Input
                  id="ct-auth-header"
                  className="tabular mt-1"
                  value={draft.authHeaderName ?? ''}
                  placeholder="X-API-Key"
                  onChange={(e) => patch({ authHeaderName: e.target.value })}
                />
              </label>
            )}
            {draft.authType === 'basic' && (
              <label className="min-w-[160px]" htmlFor="ct-auth-user">
                <span className="field-label">Usuario</span>
                <Input
                  id="ct-auth-user"
                  className="tabular mt-1"
                  value={draft.authUsername ?? ''}
                  autoComplete="off"
                  onChange={(e) => patch({ authUsername: e.target.value })}
                />
              </label>
            )}
            <label className="min-w-[240px] flex-1" htmlFor="ct-auth-secret">
              <span className="field-label">
                {editingId
                  ? draft.authType === 'basic'
                    ? 'Nueva contraseña (vacío conserva la actual)'
                    : 'Nueva llave (vacío conserva la actual)'
                  : draft.authType === 'basic'
                    ? 'Contraseña'
                    : 'La llave'}
              </span>
              <Input
                id="ct-auth-secret"
                className="tabular mt-1"
                type="password"
                autoComplete="new-password"
                value={draft.authSecret ?? ''}
                placeholder="••••••••••••"
                onChange={(e) => patch({ authSecret: e.target.value })}
              />
            </label>
          </div>
        )}
      </div>

      {/* 7 — Confirmation posture */}
      <div className="mt-4">
        <span className={LABEL}>¿Le pregunta a alguien antes?</span>
        <label className="mt-1.5 flex items-start gap-2 text-xs leading-snug text-ink-muted">
          <input
            type="checkbox"
            checked={gated}
            onChange={(e) => patch({ requiresConfirmation: e.target.checked })}
            className={clsx(CHECKBOX_CLASS, 'mt-0.5')}
          />
          <span>
            Pedir confirmación antes de ejecutarla.
            {writes && (
              <span className="block text-ink-faint">
                {draft.method} cambia datos del otro lado, así que viene marcado por defecto.
              </span>
            )}
          </span>
        </label>
        {writes && !gated && (
          <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-micro leading-relaxed text-amber">
            Esta herramienta escribe en un sistema externo y quedaría sin confirmación: Cortex podrá
            ejecutarla sola, también en rutinas donde no hay nadie mirando. Queda en la auditoría,
            pero nadie la aprueba antes.
          </p>
        )}
      </div>

      {/* 8 — Everything most people never touch */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          <ChevronDown
            className={clsx(
              'h-3.5 w-3.5 transition-transform motion-reduce:transition-none',
              advanced && 'rotate-180',
            )}
          />
          Opciones avanzadas
        </button>

        {advanced && (
          <div className="mt-2 grid grid-cols-1 gap-3 rounded-card border border-border bg-surface p-3 sm:grid-cols-2">
            <label htmlFor="ct-slug">
              <span className="field-label">Identificador</span>
              <Input
                id="ct-slug"
                className="tabular mt-1"
                value={draft.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  patch({ slug: e.target.value });
                }}
              />
              <span className="mt-0.5 block text-micro text-ink-faint">
                Cambiarlo renombra la herramienta en la auditoría y en los permisos.
              </span>
            </label>
            <label htmlFor="ct-response-path">
              <span className="field-label">De la respuesta, quédate con</span>
              <Input
                id="ct-response-path"
                className="tabular mt-1"
                value={draft.responsePath ?? ''}
                placeholder="data.items"
                onChange={(e) => patch({ responsePath: e.target.value })}
              />
              <span className="mt-0.5 block text-micro text-ink-faint">
                Vacío devuelve todo. Sirve para no llenarle el contexto al modelo con envoltorios.
              </span>
            </label>
            <label htmlFor="ct-response-max">
              <span className="field-label">Máximo de caracteres de la respuesta</span>
              <Input
                id="ct-response-max"
                className="tabular mt-1"
                type="number"
                min={200}
                max={50000}
                value={draft.responseMaxChars}
                onChange={(e) => patch({ responseMaxChars: Number(e.target.value) })}
              />
            </label>
            <label htmlFor="ct-timeout">
              <span className="field-label">Se rinde después de (ms)</span>
              <Input
                id="ct-timeout"
                className="tabular mt-1"
                type="number"
                min={1000}
                max={60000}
                value={draft.timeoutMs}
                onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              />
            </label>
            <label htmlFor="ct-rate">
              <span className="field-label">Tope de llamadas por minuto</span>
              <Input
                id="ct-rate"
                className="tabular mt-1"
                type="number"
                min={1}
                max={120}
                value={draft.rateLimitPerMinute}
                onChange={(e) => patch({ rateLimitPerMinute: Number(e.target.value) })}
              />
            </label>
            <div className="flex flex-col gap-2 pt-4">
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={draft.followRedirects}
                  onChange={(e) => patch({ followRedirects: e.target.checked })}
                  className={CHECKBOX_CLASS}
                />
                Seguir redirecciones
              </label>
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={draft.allowInsecureHttp}
                  onChange={(e) => patch({ allowInsecureHttp: e.target.checked })}
                  className={CHECKBOX_CLASS}
                />
                Permitir http sin cifrar
              </label>
            </div>
            <label className="sm:col-span-2" htmlFor="ct-headers">
              <span className="field-label">Cabeceras fijas (una por línea: Nombre: valor)</span>
              <textarea
                id="ct-headers"
                rows={3}
                className={clsx(TEXTAREA_CLASS, 'tabular mt-1')}
                value={Object.entries(draft.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
                placeholder="Accept: application/json"
                onChange={(e) => {
                  const headers: Record<string, string> = {};
                  for (const line of e.target.value.split('\n')) {
                    const idx = line.indexOf(':');
                    if (idx <= 0) continue;
                    const name = line.slice(0, idx).trim();
                    if (name) headers[name] = line.slice(idx + 1).trim();
                  }
                  patch({ headers });
                }}
              />
            </label>
          </div>
        )}
      </div>

      {(problems.length > 0 || saveError) && (
        <div className="mt-4 rounded-card border border-rose/30 bg-rose-soft px-3 py-2">
          {saveError && <p className="text-xs font-semibold text-rose">{saveError}</p>}
          {problems.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-micro leading-relaxed text-rose">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Crear herramienta'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className={CHECKBOX_CLASS}
          />
          Dejarla encendida
        </label>
      </div>
    </form>
  );
}
