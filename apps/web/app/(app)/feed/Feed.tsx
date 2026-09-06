'use client';

import { type SpaceChoice, listWritableSpacesAction } from '@/app/(chat)/chat/actions';
import { PageHeader } from '@/components/ui/page-header';
import {
  FEED_ACCEPT,
  FEED_MAX_BYTES,
  FEED_MAX_TEXT,
  type FeedDetail,
  type FeedEntry,
} from '@/lib/feed/shared';
import {
  Brain,
  Check,
  FileText,
  Inbox,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';

const inputClass =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-sm px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 disabled:cursor-not-allowed';
const icons = { file: FileText, url: Link2, text: FileText };
const kinds = { file: 'Archivo', url: 'Enlace', text: 'Texto' };

export function Feed({ initialEntries }: { initialEntries: FeedEntry[] }) {
  const router = useRouter();
  const [entries, setEntries] = useState(initialEntries);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedDetail | null>(null);
  const [mode, setMode] = useState<'file' | 'url' | 'text'>('file');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [spaces, setSpaces] = useState<SpaceChoice[]>([]);
  const [space, setSpace] = useState('');
  const [sheet, setSheet] = useState(0);

  async function refresh() {
    const res = await fetch('/api/feed');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'No se pudo actualizar Feed.');
    setEntries(data.entries);
  }

  useEffect(() => {
    setDetail(null);
    setSaving(false);
    setDeleting(false);
    setSheet(0);
    if (!selected) return;
    const controller = new AbortController();
    void fetch(`/api/feed/${selected}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'No se pudo leer la entrada.');
        setDetail(data.entry);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
          setSelected(null);
        }
      });
    return () => controller.abort();
  }, [selected]);

  async function add(form: FormData) {
    const res = await fetch('/api/feed', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'No se pudo añadir la entrada.');
    setEntries((prev) => [data.entry, ...prev]);
    setSelected(data.entry.id);
    setNotice('Añadido a Feed. Disponible para consulta durante siete días.');
  }

  async function upload(files: File[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set('kind', 'file');
        form.set('file', file);
        await add(form);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
    } finally {
      setBusy(false);
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: FEED_ACCEPT,
    maxSize: FEED_MAX_BYTES,
    disabled: busy,
    onDropAccepted: (files) => void upload(files),
    onDropRejected: () =>
      setError('Usa PDF, DOCX, XLSX, CSV, TXT o Markdown, de hasta 10 MB por archivo.'),
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set('kind', mode);
      form.set('url', url);
      form.set('title', title);
      form.set('text', text);
      await add(form);
      setUrl('');
      setTitle('');
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo añadir la entrada.');
    } finally {
      setBusy(false);
    }
  }

  async function act(action: 'consult' | 'promote' | 'delete') {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/feed/${detail.id}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'delete'
          ? {}
          : { body: JSON.stringify({ action, ...(space ? { space } : {}) }) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'No se pudo completar la acción.');
      if (action === 'consult') {
        router.push(data.href);
        return;
      }
      if (action === 'delete') {
        setSelected(null);
        setDetail(null);
        setNotice('Entrada eliminada de Feed.');
      } else {
        setDetail({ ...detail, promoted_document_id: data.result.documentId });
        setSaving(false);
        setNotice(data.result.note);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(false);
    }
  }

  async function openSave() {
    setError(null);
    try {
      setSpaces(await listWritableSpacesAction());
      setSpace('');
      setSaving(true);
    } catch {
      setError('No se pudieron cargar los espacios.');
    }
  }

  const filtered = entries.filter((entry) =>
    `${entry.filename} ${entry.source_url ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const table = detail?.feed_tables?.[sheet];

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Feed"
        icon={<Inbox className="h-5 w-5" />}
        subtitle="Trae archivos, enlaces o texto para trabajar con Cortex. Solo tú puedes verlos; duran siete días y tú decides qué guardar en el cerebro."
      />

      <section
        aria-label="Añadir información"
        className="mb-7 rounded-card border border-border bg-surface p-4 sm:p-5"
      >
        <div className="mb-4 flex flex-wrap gap-1" aria-label="Tipo de entrada">
          {(['file', 'url', 'text'] as const).map((kind) => {
            const Icon = kind === 'file' ? Upload : kind === 'url' ? Link2 : FileText;
            return (
              <button
                key={kind}
                type="button"
                disabled={busy}
                aria-pressed={mode === kind}
                onClick={() => setMode(kind)}
                className={`${buttonClass} ${mode === kind ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-surface-2'}`}
              >
                <Icon size={16} aria-hidden />
                {kind === 'file'
                  ? 'Subir archivos'
                  : kind === 'url'
                    ? 'Pegar enlace'
                    : 'Escribir texto'}
              </button>
            );
          })}
        </div>
        {mode === 'file' ? (
          <div
            {...getRootProps()}
            className={`flex cursor-pointer flex-col items-center rounded-sm border border-dashed px-4 py-8 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${isDragActive ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface-2'}`}
          >
            <input {...getInputProps({ 'aria-label': 'Subir archivos a Feed' })} />
            {busy ? (
              <Loader2 className="mb-3 animate-spin text-primary" aria-hidden />
            ) : (
              <Upload className="mb-3 text-primary" aria-hidden />
            )}
            <p className="font-medium text-ink">
              {busy
                ? 'Leyendo el contenido…'
                : isDragActive
                  ? 'Suelta los archivos aquí'
                  : 'Arrastra archivos o haz clic para elegir'}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              PDF, Word, Excel, CSV y texto · Hasta 10 MB por archivo
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {mode === 'url' ? (
              <>
                <label htmlFor="feed-url" className="block text-sm font-medium text-ink">
                  Enlace de una página pública
                </label>
                <input
                  id="feed-url"
                  type="url"
                  required
                  maxLength={2048}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://ejemplo.com/informe"
                  className={inputClass}
                  disabled={busy}
                />
                <p className="text-xs text-ink-muted">
                  Se captura el contenido de hoy. Las páginas que requieren iniciar sesión pueden no
                  estar disponibles.
                </p>
              </>
            ) : (
              <>
                <label htmlFor="feed-title" className="block text-sm font-medium text-ink">
                  Título
                </label>
                <input
                  id="feed-title"
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Por ejemplo: contexto para la reunión"
                  className={inputClass}
                  disabled={busy}
                />
                <label htmlFor="feed-text" className="block text-sm font-medium text-ink">
                  Contenido
                </label>
                <textarea
                  id="feed-text"
                  required
                  value={text}
                  maxLength={FEED_MAX_TEXT}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  placeholder="Pega tus notas, un correo o la información que quieres consultar…"
                  className={inputClass}
                  disabled={busy}
                />
              </>
            )}
            <button
              disabled={busy}
              type="submit"
              className={`${buttonClass} bg-primary text-white hover:bg-primary-strong`}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}Añadir a
              Feed
            </button>
          </form>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-sm bg-rose-soft p-3 text-sm text-rose"
        >
          {error}
          <button type="button" aria-label="Cerrar error" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <output className="mb-4 rounded-sm bg-emerald-soft p-3 text-sm text-ink">{notice}</output>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
        <section aria-label="Tus entradas" className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Tus entradas</h2>
            <span className="text-sm text-ink-faint">{entries.length}</span>
          </div>
          {entries.length > 0 && (
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-3 text-ink-faint" aria-hidden />
              <input
                aria-label="Buscar en Feed"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nombre o enlace"
                className={`${inputClass} pl-9`}
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="py-8 text-sm leading-relaxed text-ink-muted">
              {query
                ? 'No hay entradas que coincidan con esa búsqueda.'
                : 'Lo que añadas aparecerá aquí. Puedes consultarlo primero y decidir después si vale la pena conservarlo.'}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((entry) => {
                const Icon = icons[entry.feed_kind];
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={selected === entry.id}
                      onClick={() => setSelected(entry.id)}
                      className={`flex w-full gap-3 rounded-sm px-3 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${selected === entry.id ? 'bg-primary-soft' : 'hover:bg-surface'}`}
                    >
                      <Icon size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          {entry.filename}
                        </span>
                        <span className="mt-1 block text-xs text-ink-muted">
                          {kinds[entry.feed_kind]} ·{' '}
                          {new Date(entry.created_at).toLocaleDateString('es-CO', {
                            timeZone: 'America/Bogota',
                          })}
                        </span>
                        <span className="mt-1 block text-xs text-ink-muted">
                          {entry.promoted_document_id
                            ? 'También guardado en el cerebro'
                            : 'Sólo para consulta'}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          aria-label="Vista previa"
          className="min-w-0 rounded-card border border-border bg-surface p-4 sm:p-5"
        >
          {!detail ? (
            <div className="flex min-h-64 flex-col items-center justify-center text-center text-ink-muted">
              <Inbox size={28} className="mb-3 text-ink-faint" aria-hidden />
              <p className="text-sm">
                {selected ? 'Cargando la entrada…' : 'Elige una entrada para ver su contenido.'}
              </p>
            </div>
          ) : (
            <>
              <h2 className="break-words text-lg font-semibold text-ink">{detail.filename}</h2>
              <p className="mt-1 text-xs text-ink-muted">
                Disponible hasta el{' '}
                {new Date(detail.purge_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}
              </p>
              {detail.source_url && (
                <a
                  href={detail.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block break-all text-sm text-primary underline"
                >
                  Abrir página original
                </a>
              )}
              <div className="my-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act('consult')}
                  className={`${buttonClass} bg-primary text-white hover:bg-primary-strong`}
                >
                  <MessageSquare size={16} />
                  {detail.conversation_id ? 'Continuar consulta' : 'Consultar con Cortex'}
                </button>
                {detail.promoted_document_id ? (
                  <span className="inline-flex items-center gap-1 px-2 text-xs text-emerald">
                    <Check size={14} />
                    Guardado en el cerebro
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openSave()}
                    className={`${buttonClass} border border-border text-ink hover:bg-surface-2`}
                  >
                    <Brain size={16} />
                    Guardar en el cerebro
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Eliminar entrada"
                  onClick={() => setDeleting(true)}
                  className={`${buttonClass} text-ink-muted hover:bg-rose-soft hover:text-rose`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {saving && (
                <div className="mb-4 space-y-3 rounded-sm bg-surface-2 p-3">
                  <p className="text-sm text-ink">
                    Se conservará en el espacio que elijas y podrá usarse en futuras respuestas.
                  </p>
                  <label htmlFor="feed-space" className="block text-sm font-medium text-ink">
                    Guardar en
                  </label>
                  <select
                    id="feed-space"
                    value={space}
                    onChange={(e) => setSpace(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Mis notas privadas</option>
                    {spaces.map((s) => (
                      <option key={s.id} value={s.name} disabled={!s.writable}>
                        {s.name}
                        {!s.writable ? ' (sin permiso de escritura)' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act('promote')}
                      className={`${buttonClass} bg-primary text-white`}
                    >
                      {busy ? 'Guardando…' : 'Guardar en este espacio'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setSaving(false)}
                      className={buttonClass}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {deleting && (
                <div className="mb-4 rounded-sm bg-rose-soft p-3 text-sm text-ink">
                  <p>
                    Se eliminarán esta entrada y su archivo temporal. Las respuestas del chat y las
                    copias que guardaste en el cerebro se conservan.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act('delete')}
                      className={`${buttonClass} text-rose`}
                    >
                      Eliminar de Feed
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleting(false)}
                      className={buttonClass}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {(detail.feed_truncated || detail.extracted_text.length > 12000) && (
                <p className="mb-3 rounded-sm bg-amber-soft p-3 text-xs text-ink">
                  {detail.feed_truncated ? 'La página se capturó parcialmente. ' : ''}El chat recibe
                  una lectura inicial de hasta 12.000 caracteres. Para hojas de cálculo, Cortex
                  también puede consultar las filas y calcular sobre la tabla completa.
                </p>
              )}
              {table ? (
                <>
                  <label htmlFor="feed-sheet" className="mb-2 block text-xs text-ink-muted">
                    Hoja de cálculo
                  </label>
                  <select
                    id="feed-sheet"
                    value={sheet}
                    onChange={(e) => setSheet(Number(e.target.value))}
                    className={inputClass}
                  >
                    {detail.feed_tables?.map((t, i) => (
                      <option key={`${i}-${t.name}`} value={i}>
                        {t.name} ({t.rows.length} filas)
                      </option>
                    ))}
                  </select>
                  <div className="mt-3 max-h-96 overflow-auto rounded-sm border border-border">
                    <table className="w-full text-left text-xs">
                      <caption className="sr-only">Vista previa de {table.name}</caption>
                      <tbody>
                        {table.rows.slice(0, 100).map((row, r) => (
                          <tr
                            key={`${table.name}-row-${r}`}
                            className={
                              r === 0 ? 'bg-surface-2 font-semibold' : 'border-t border-border'
                            }
                          >
                            <th
                              scope="row"
                              className="sticky left-0 bg-surface-2 px-2 py-2 text-ink-faint"
                            >
                              {r + 1}
                            </th>
                            {row.map((cell, c) => (
                              <td
                                key={`${table.name}-cell-${r}-${c}`}
                                className="max-w-64 truncate whitespace-nowrap px-3 py-2 text-ink"
                                title={String(cell ?? '')}
                              >
                                {String(cell ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-ink-muted">
                    Vista previa: {Math.min(table.rows.length, 100)} de {table.rows.length} filas.
                    Se conservan todas las celdas leídas. Las fórmulas usan el resultado guardado en
                    Excel.
                  </p>
                </>
              ) : (
                <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border-t border-border pt-4 font-sans text-sm leading-relaxed text-ink">
                  {detail.extracted_text}
                </pre>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
