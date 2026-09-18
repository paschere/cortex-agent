import {
  type ManagementCase,
  type ManagementState,
  managementPriority,
  managementStateLabels,
} from './shape';

export const INBOX_BUCKETS = ['decisions', 'blocked', 'working'] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

export type ManagementInboxItem = {
  id: string;
  bucket: InboxBucket;
  title: string;
  state: ManagementState;
  stateLabel: string;
  ownerId: string | null;
  dueOn: string;
  nextReviewOn: string;
  nextAction: string;
  blocker: string;
  reasons: string[];
  priority: number;
  evidence: 'missing' | 'source' | 'ready' | 'verified';
  evidenceLabel: string;
  href: string;
};

export type ManagementInbox = {
  decisions: ManagementInboxItem[];
  blocked: ManagementInboxItem[];
  working: ManagementInboxItem[];
  all: ManagementInboxItem[];
};

function evidenceFor(item: ManagementCase): ManagementInboxItem['evidence'] {
  if (item.data.state === 'verified' && item.data.evidence) return 'verified';
  if (item.data.state === 'review' && item.data.evidence) return 'ready';
  if (item.data.activationEvidence) return 'source';
  return 'missing';
}

function evidenceLabel(evidence: ManagementInboxItem['evidence']) {
  switch (evidence) {
    case 'verified':
      return 'Evidencia revisada';
    case 'ready':
      return 'Evidencia lista para revisar';
    case 'source':
      return 'Origen guardado; falta cierre';
    default:
      return 'Falta evidencia de cierre';
  }
}

function bucketFor(
  item: ManagementCase,
  userId: string,
  isAdmin: boolean,
  all: ManagementCase[],
): InboxBucket | null {
  const state = item.data.state;
  if (['verified', 'cancelled'].includes(state)) return null;
  if (state === 'review' && isAdmin) return 'decisions';
  const hasUnverifiedDependency = Boolean(
    item.data.dependsOn &&
      !all.some(
        (candidate) => candidate.id === item.data.dependsOn && candidate.data.state === 'verified',
      ),
  );
  if (state === 'blocked' || !item.data.ownerId || hasUnverifiedDependency) return 'blocked';
  // An in-progress item belongs to the person's working queue when they own
  // it, and remains visible to a manager when another person owns it. The
  // category is intentionally exclusive so one case cannot appear twice.
  if (['open', 'working'].includes(state)) return 'working';
  if (state === 'review' && item.data.ownerId === userId) return 'working';
  return null;
}

export function buildManagementInbox(
  cases: ManagementCase[],
  userId: string,
  today: string,
  isAdmin: boolean,
): ManagementInbox {
  const items: ManagementInboxItem[] = [];
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const bucket = bucketFor(item, userId, isAdmin, cases);
    if (!bucket) continue;
    const priority = managementPriority(item, today, cases);
    const evidence = evidenceFor(item);
    items.push({
      id: item.id,
      bucket,
      title: item.data.title,
      state: item.data.state,
      stateLabel: managementStateLabels[item.data.state],
      ownerId: item.data.ownerId,
      dueOn: item.data.dueOn,
      nextReviewOn: item.data.nextReviewOn,
      nextAction: item.data.nextAction,
      blocker: item.data.blocker,
      reasons: priority.reasons,
      priority: priority.score,
      evidence,
      evidenceLabel: evidenceLabel(evidence),
      href: `/management?case=${encodeURIComponent(item.id)}`,
    });
  }
  const sorted = items.sort(
    (a, b) => b.priority - a.priority || a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id),
  );
  return {
    decisions: sorted.filter((item) => item.bucket === 'decisions'),
    blocked: sorted.filter((item) => item.bucket === 'blocked'),
    working: sorted.filter((item) => item.bucket === 'working'),
    all: sorted,
  };
}
