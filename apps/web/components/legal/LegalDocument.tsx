import { isPlaceholder, legalEntity } from '@/lib/legal/config';
import { type Block, type LegalDocumentContent, legalDocumentBySlug } from '@/lib/legal/documents';
import type { ReactNode } from 'react';

/**
 * Pinta un documento legal. Los marcadores que faltan ([RAZÓN SOCIAL],
 * [NIT]…, y las notas [REVISAR CON EL ABOGADO]) se resaltan con <mark> para
 * que nadie los confunda con texto definitivo.
 */

const MARKER = /(\[[A-ZÁÉÍÓÚÑ/ ][^\]]*\])/g;

function withMarks(text: string): ReactNode {
  const parts = text.split(MARKER);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    isPlaceholder(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: partes fijas de un texto estático
      <mark key={i}>{part}</mark>
    ) : (
      part
    ),
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  if (typeof block === 'string') return <p key={key}>{withMarks(block)}</p>;
  if ('list' in block) {
    return (
      <ul key={key}>
        {block.list.map((item) => (
          <li key={item}>{withMarks(item)}</li>
        ))}
      </ul>
    );
  }
  if ('note' in block) {
    return (
      <p key={key} className="legal-note">
        {withMarks(block.note)}
      </p>
    );
  }
  return (
    <div key={key} className="legal-table">
      <table>
        <thead>
          <tr>
            {block.table.head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.table.rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas
                <td key={i}>{withMarks(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalDocumentView({ doc, draft }: { doc: LegalDocumentContent; draft: boolean }) {
  return (
    <>
      <nav aria-label="Secciones" className="legal-toc">
        {doc.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.heading}
          </a>
        ))}
      </nav>
      <article className="legal-doc">
        <p className="legal-kicker">Documento legal{draft ? ' · versión preliminar' : ''}</p>
        <h1>{doc.title}</h1>
        <p className="legal-summary">{doc.summary}</p>
        <p className="legal-meta">Versión {doc.version}</p>
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`}>{s.heading}</h2>
            {s.blocks.map((b, i) => renderBlock(b, i))}
          </section>
        ))}
      </article>
    </>
  );
}

/** Lo que cada page.tsx renderiza: el documento con los datos del entorno. */
export function LegalPage({ slug }: { slug: LegalDocumentContent['slug'] }) {
  const entity = legalEntity();
  return <LegalDocumentView doc={legalDocumentBySlug(slug, entity)} draft={entity.draft} />;
}
