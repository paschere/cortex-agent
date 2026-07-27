import { CircleDot, CircleSlash, Send, ThumbsUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SignalStatus } from './types';

/**
 * One description of each stage, shared by the funnel and the cards so a colour
 * never means two things. Rose is reserved for rejected and amber for "a person
 * still has to look at this", matching the approvals queue.
 */
export interface StatusMeta {
  label: string;
  /** Past-tense form for the "Qualified by Ana" line. */
  done: string;
  blurb: string;
  chip: string;
  bar: string;
  ring: string;
  icon: LucideIcon;
}

export const STATUS_META: Record<SignalStatus, StatusMeta> = {
  new: {
    label: 'New',
    done: 'Found',
    blurb: 'waiting on a decision',
    chip: 'bg-amber-soft text-amber',
    bar: 'bg-amber',
    ring: 'ring-amber',
    icon: CircleDot,
  },
  qualified: {
    label: 'Qualified',
    done: 'Qualified',
    blurb: 'worth approaching',
    chip: 'bg-emerald-soft text-emerald',
    bar: 'bg-emerald',
    ring: 'ring-emerald',
    icon: ThumbsUp,
  },
  contacted: {
    label: 'Contacted',
    done: 'Contacted',
    blurb: 'we have reached out',
    chip: 'bg-primary-soft text-primary',
    bar: 'bg-primary',
    ring: 'ring-primary',
    icon: Send,
  },
  rejected: {
    label: 'Rejected',
    done: 'Rejected',
    blurb: 'kept so nobody looks twice',
    chip: 'bg-rose-soft text-rose',
    bar: 'bg-rose',
    ring: 'ring-rose',
    icon: CircleSlash,
  },
};
