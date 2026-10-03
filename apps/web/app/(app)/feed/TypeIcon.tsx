import { IconTile } from '@/components/sources/visuals';
import {
  Braces,
  Combine,
  FileSpreadsheet,
  FileText,
  FileType2,
  Globe,
  NotebookPen,
  Sheet,
} from 'lucide-react';
import type { FeedType } from './inbox-model';

/** El icono de cada tipo de entrada, con el color de su familia (como en Datos y conexiones). */
const TYPE: Record<
  FeedType,
  { icon: typeof FileText; tone: 'rose' | 'sky' | 'emerald' | 'primary' | 'neutral' | 'amber' }
> = {
  pdf: { icon: FileType2, tone: 'rose' },
  word: { icon: FileText, tone: 'sky' },
  sheet: { icon: FileSpreadsheet, tone: 'emerald' },
  csv: { icon: Sheet, tone: 'emerald' },
  text: { icon: NotebookPen, tone: 'amber' },
  link: { icon: Globe, tone: 'neutral' },
  gsheet: { icon: FileSpreadsheet, tone: 'emerald' },
  api: { icon: Braces, tone: 'primary' },
  combined: { icon: Combine, tone: 'primary' },
};

export function TypeIcon({ type, size = 'md' }: { type: FeedType; size?: 'sm' | 'md' }) {
  const t = TYPE[type];
  return <IconTile icon={t.icon} tone={t.tone} size={size} />;
}
