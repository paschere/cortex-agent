import type { ScreenResult } from '@/components/statements/types';
import type { BoardReport, BoardSettings } from '@cortex/agent-tools';

export interface BoardLinks {
  self: string;
  statements: string;
  budget: string;
  integrations: string;
  schedules: string;
}

export interface BoardActions {
  generate: (period: string) => Promise<ScreenResult & { id?: string; href?: string }>;
  saveSettings: (input: {
    enabled: boolean;
    dayOfMonth: number;
    hour: number;
    recipients: string[];
  }) => Promise<ScreenResult>;
  setAccess: (
    id: string,
    input: {
      visibility: 'privado' | 'enlace' | 'contrasena';
      password?: string;
      days?: number | null;
      rotate?: boolean;
    },
  ) => Promise<ScreenResult & { url?: string | null }>;
  send: (id: string, to: string[], message: string | null) => Promise<ScreenResult>;
}

export interface BoardHomeProps {
  today: string;
  reports: BoardReport[];
  settings: BoardSettings;
  canEdit: boolean;
  defaultPeriod: string;
  /** Meses que se pueden informar (del más reciente al más viejo). */
  periods: Array<{ value: string; label: string }>;
  links: BoardLinks;
  /** Por id de informe: su detalle y su PDF, ya con el espacio de trabajo. */
  hrefs: Record<string, { detail: string; pdf: string }>;
  actions: Pick<BoardActions, 'generate' | 'saveSettings'>;
}

export interface BoardDetailProps {
  report: BoardReport;
  canEdit: boolean;
  recipients: string[];
  publicUrl: string | null;
  links: { list: string; pdf: string };
  actions: Pick<BoardActions, 'generate' | 'setAccess' | 'send'>;
}
