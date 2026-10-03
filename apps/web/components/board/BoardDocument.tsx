import type { BoardContent } from '@cortex/agent-tools';
import { clsx } from 'clsx';

/**
 * EL INFORME PARA SOCIOS, PINTADO (0191). Sin estado ni efectos: lo usan la
 * pantalla de detalle (detrás de la sesión) y el enlace público
 * (/informe/<token>). Pinta exactamente lo guardado: no recalcula nada.
 */
export function BoardDocument({
  content,
  accent,
}: { content: BoardContent; accent?: string | null }) {
  return (
    <article className="mx-auto max-w-4xl space-y-8 text-ink">
      <header className="border-b border-border pb-5">
        <p className="text-micro font-bold uppercase tracking-widest text-ink-faint">
          Informe para socios
        </p>
        <h1
          className="mt-1 text-2xl font-extrabold sm:text-3xl"
          style={accent ? { color: accent } : undefined}
        >
          {content.periodLabel.charAt(0).toUpperCase() + content.periodLabel.slice(1)}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{content.company}</p>
      </header>
      {content.sections.map((s) => (
        <section key={s.key} aria-labelledby={`sec-${s.key}`} className="break-inside-avoid">
          <h2 id={`sec-${s.key}`} className="text-lg font-extrabold">
            {s.title}
          </h2>
          <ul className={clsx('mt-3 space-y-2', s.key === 'resumen' ? 'text-base' : 'text-sm')}>
            {(s.key === 'resumen' ? content.summary : s.lines).map((line, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: el texto puede repetirse
                key={i}
                className="flex gap-3"
              >
                <span
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  style={accent ? { backgroundColor: accent } : undefined}
                  aria-hidden
                />
                <span className={s.key === 'resumen' ? 'leading-relaxed' : 'text-ink-muted'}>
                  {line}
                </span>
              </li>
            ))}
          </ul>
          {s.table && s.table.rows.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-sm border border-border">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-surface-2">
                  <tr>
                    {s.table.columns.map((c, i) => (
                      <th
                        key={c}
                        scope="col"
                        className={clsx(
                          'px-3 py-2 text-micro font-bold uppercase tracking-wide text-ink-faint',
                          s.table?.numeric?.includes(i) ? 'text-right' : 'text-left',
                        )}
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {s.table.rows.map((r, ri) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: filas fijas del informe
                    <tr key={ri}>
                      {r.map((cell, ci) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas
                          key={ci}
                          className={clsx(
                            'px-3 py-2 align-top',
                            s.table?.numeric?.includes(ci)
                              ? 'tabular whitespace-nowrap text-right font-mono'
                              : ci === 0
                                ? 'font-medium'
                                : 'text-ink-muted',
                          )}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
      <footer className="border-t border-border pt-4 text-micro text-ink-faint">
        Cifras de caja del libro de Cortex (lo que entró y salió), sin causación ni depreciaciones,
        salvo donde se indica el programa contable.
        {content.summarySource === 'plantilla'
          ? ' El resumen se armó con una plantilla a partir de las mismas cifras.'
          : ''}
        {content.gaps.length ? ` No se pudo leer: ${content.gaps.join(', ')}.` : ''}
      </footer>
    </article>
  );
}
