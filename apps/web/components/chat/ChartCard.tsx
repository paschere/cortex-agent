'use client';

import { saveChartAsReportAction } from '@/app/(chat)/chat/actions';
import { clsx } from 'clsx';
import { BookmarkCheck, ChartNoAxesColumn, Loader2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * A chart, inside the conversation, with the one button that matters.
 *
 * ===========================================================================
 * WHY THE MARKUP IS INJECTED
 * ===========================================================================
 * The same trade the saved-report page makes, for the same reason: every byte
 * of `html` was produced by our renderer, and no model text, database text or
 * user text reaches it except through the escaping boundary in
 * `reports/html.ts`. Rebuilding the chart as a React tree here would mean two
 * renderings of one document that nothing forces to agree — and we would find
 * out when a client said the chart in the chat did not match the informe.
 *
 * The stylesheet is `REPORT_CSS`, served as a real sheet at `/report.css` and
 * linked once from the root layout — it used to be a `<style>` inside the chat
 * layout, which meant it only existed on one half of the app and travelled in
 * every RSC payload. See `app/report.css/route.ts`. Every rule is scoped to
 * `.rp-doc`, which is why the wrapper carries that class.
 *
 * ===========================================================================
 * WHY IT IS FETCHED RATHER THAN STREAMED
 * ===========================================================================
 * The tool result holds an id, not a picture. A tool result is part of the
 * transcript and is replayed into the model's context every subsequent turn, so
 * twenty kilobytes of SVG there would be re-sent and re-paid for, turn after
 * turn, to a reader that cannot see it. See the route this calls.
 */

interface ChartPayload {
  id: string;
  title: string;
  html: string;
  savedReportId: string | null;
}

export function ChartCard({ chartId, heading }: { chartId: string; heading: string }) {
  const [payload, setPayload] = useState<ChartPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/chat/charts/${chartId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((data: ChartPayload) => {
        if (!alive) return;
        setPayload(data);
        if (data.savedReportId) setSavedUrl(`/reports/${data.savedReportId}`);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [chartId]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    const result = await saveChartAsReportAction(chartId);
    setSaving(false);
    if (!result.ok || !result.url) {
      setSaveError(result.error ?? 'No se pudo guardar el informe.');
      return;
    }
    setSavedUrl(result.url);
  }

  if (failed) {
    return (
      <div className="mt-2 flex items-start gap-2.5 rounded-card border border-border bg-surface-2 px-3.5 py-3 text-xs text-ink-muted shadow-card">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
        <span>
          Este gráfico ya no está disponible. Los que nadie conserva se borran a los 30 días;
          vuelve a pedirlo y queda otra vez.
        </span>
      </div>
    );
  }

  return (
    <figure className="mt-2 overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <figcaption className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <ChartNoAxesColumn className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {payload?.title ?? heading}
        </span>

        {savedUrl ? (
          // Once it is an informe the button becomes the way there. Offering
          // "guardar" again would invite a second identical report.
          <Link
            href={savedUrl}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-emerald-soft px-3 py-1 text-micro font-semibold text-emerald transition-colors duration-150 hover:bg-emerald/15 motion-reduce:transition-none"
          >
            <BookmarkCheck className="h-3.5 w-3.5" aria-hidden />
            Guardado — abrir informe
          </Link>
        ) : (
          <button
            type="button"
            onClick={save}
            disabled={saving || !payload}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-micro font-semibold text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink disabled:opacity-40 motion-reduce:transition-none"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <BookmarkCheck className="h-3.5 w-3.5" aria-hidden />
            )}
            Conservar como informe
          </button>
        )}
      </figcaption>

      <div className="px-4 py-3">
        {payload ? (
          // The wrapper carries `rp-doc` because REPORT_CSS is scoped to it.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: produced by our own renderer, which escapes every string; see the header and reports/__tests__/render.test.ts.
          <div className="rp-doc" dangerouslySetInnerHTML={{ __html: payload.html }} />
        ) : (
          <div
            className="flex items-center gap-2 py-6 text-xs text-ink-faint"
            aria-live="polite"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Dibujando el gráfico…
          </div>
        )}
      </div>

      {saveError && (
        <p
          role="alert"
          className={clsx('border-t border-rose/20 bg-rose-soft px-4 py-2 text-xs text-rose')}
        >
          {saveError}
        </p>
      )}
    </figure>
  );
}
