import type { TaxDraftScreen, TaxTabLinks } from '@/components/tax/types';
import {
  DRAFT_STATUS_LABEL,
  type DraftFigures,
  OBLIGATION_STATUS_LABEL,
  type TaxDraftRecord,
  type TaxObligation,
  daysBetween,
} from '@cortex/agent-tools';
import { obligationTone, shortDay } from './screen';

/**
 * DEL BORRADOR A LA PANTALLA (0197). Puro: recibe la obligación, las cifras
 * (vivas o congeladas) y el borrador guardado, y devuelve lo que pinta
 * components/tax/DraftView. La ficha de muestra lo usa igual.
 */

function when(daysLeft: number): string {
  if (daysLeft < 0) return `Venció hace ${-daysLeft} día${daysLeft === -1 ? '' : 's'}`;
  if (daysLeft === 0) return 'Vence hoy';
  if (daysLeft === 1) return 'Vence mañana';
  return `Vence en ${daysLeft} días`;
}

export function buildDraftScreen(input: {
  obligation: TaxObligation;
  figures: DraftFigures;
  saved: TaxDraftRecord | null;
  today: string;
  canAct: boolean;
  href: (path: string) => string;
  tabs: TaxTabLinks;
  people?: Map<string, string>;
}): TaxDraftScreen {
  const o = input.obligation;
  const daysLeft = daysBetween(input.today, o.dueDate);
  const s = input.saved;
  const who = (id: string | null) => (id ? (input.people?.get(id) ?? null) : null);
  const paths = new Set<string>();
  for (const sec of input.figures.sections)
    for (const l of sec.lines) for (const src of l.sources) if (src.path) paths.add(src.path);
  for (const m of input.figures.missing) for (const r of m.refs) if (r.path) paths.add(r.path);
  return {
    obligation: {
      id: o.id,
      title: o.title,
      dueLabel: shortDay(o.dueDate),
      whenText: o.status === 'pendiente' ? when(daysLeft) : 'Ya marcada en el calendario',
      tone: obligationTone(o, daysLeft),
      needsConfirmation: o.needsConfirmation,
      statusLabel: OBLIGATION_STATUS_LABEL[o.status],
      form: o.form,
    },
    figures: input.figures,
    saved: s
      ? {
          id: s.id,
          status: s.status,
          statusLabel: DRAFT_STATUS_LABEL[s.status],
          reviewedLabel: s.reviewedAt
            ? `Revisado${who(s.reviewedBy) ? ` por ${who(s.reviewedBy)}` : ''} el ${shortDay(s.reviewedAt.slice(0, 10))}`
            : null,
          presentedLabel: s.presentedAt
            ? `Presentado${who(s.presentedBy) ? ` por ${who(s.presentedBy)}` : ''} el ${shortDay(s.presentedAt.slice(0, 10))}`
            : null,
          evidenceHref: s.evidenceDocumentId
            ? input.href(`/kb?document=${encodeURIComponent(s.evidenceDocumentId)}`)
            : s.evidenceUrl,
          notes: s.notes,
        }
      : null,
    live: !s || s.status === 'borrador',
    canAct: input.canAct,
    hrefs: {
      back: input.tabs.calendario,
      pdf: input.href(`/api/impuestos/borrador/${o.id}/pdf`),
      upload: input.href('/api/kb/documents'),
      tabs: input.tabs,
    },
    sourceHref: Object.fromEntries([...paths].map((p) => [p, input.href(p)])),
  };
}
