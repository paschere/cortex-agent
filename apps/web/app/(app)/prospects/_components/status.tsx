import type { StatusTone } from '@/lib/status-chip';
import { CircleDot, CircleSlash, Send, ThumbsUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SignalStatus } from './types';

/**
 * One description of each stage, shared by the funnel and the cards so a colour
 * never means two things. Amber is "a person still has to look at this", green
 * is a prospect worth approaching, blue is the company acting, red is refused —
 * exactly the meanings the approvals queue uses.
 */
export interface StatusMeta {
  label: string;
  /** Past-tense form for the "Calificado por Ana" line. */
  done: string;
  blurb: string;
  tone: StatusTone;
  bar: string;
  ring: string;
  icon: LucideIcon;
}

export const STATUS_META: Record<SignalStatus, StatusMeta> = {
  new: {
    label: 'Nuevos',
    done: 'encontrado',
    blurb: 'esperan una decisión',
    tone: 'amber',
    bar: 'bg-amber',
    ring: 'ring-amber',
    icon: CircleDot,
  },
  qualified: {
    label: 'Calificados',
    done: 'calificado',
    blurb: 'vale la pena buscarlos',
    tone: 'emerald',
    bar: 'bg-emerald',
    ring: 'ring-emerald',
    icon: ThumbsUp,
  },
  contacted: {
    label: 'Contactados',
    done: 'contactado',
    blurb: 'ya los buscamos',
    tone: 'primary',
    bar: 'bg-primary',
    ring: 'ring-primary',
    icon: Send,
  },
  rejected: {
    label: 'Descartados',
    done: 'descartado',
    blurb: 'quedan para no repetir el trabajo',
    tone: 'rose',
    bar: 'bg-rose',
    ring: 'ring-rose',
    icon: CircleSlash,
  },
};
