'use client';

import {
  MEMORY_LIMIT_VIEW,
  type MemoryAction,
  type MemoryKindView,
  type MemorySourceView,
  type MemoryView,
} from '@/app/api/settings/memories/schema';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { Archive, Brain, Check, Loader2, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * Memories read as sentences, not as rows of fields — they are things Zippy
 * would say about you, and seeing them as a table of `kind | source | status`
 * makes it impossible to judge whether one is actually right. The metadata is
 * still there, underneath, in the smallest type on the page.
 */

const KIND_LABEL: Record<MemoryKindView, string> = {
  instruction: 'Always does this',
  preference: 'How you like things',
  vocabulary: 'What you mean',
  fact: 'About you',
};

const SOURCE_LABEL: Record<MemorySourceView, string> = {
  explicit: 'You told Zippy this',
  derived: 'Noticed in your conversations',
  behavioural: 'Counted from what you actually do',
};

function whenLastUseful(memory: MemoryView): string {
  if (!memory.lastUsedAt) return 'not used yet';
  const days = Math.floor((Date.now() - new Date(memory.lastUsedAt).getTime()) / 86_400_000);
  if (days <= 0) return 'used today';
  if (days === 1) return 'used yesterday';
  if (days < 30) return `last useful ${days} days ago`;
  return `last useful ${Math.floor(days / 30)} months ago`;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] text-ink-faint">{children}</span>;
}

/** One memory: the sentence first, everything else smaller and underneath. */
function MemoryCard({
  memory,
  busy,
  actions,
}: {
  memory: MemoryView;
  busy: boolean;
  actions: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between',
        busy && 'opacity-50',
      )}
    >
      <div className="min-w-0">
        <p className="text-[14px] leading-relaxed text-ink">{memory.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Meta>{KIND_LABEL[memory.kind]}</Meta>
          <Meta>·</Meta>
          <Meta>{SOURCE_LABEL[memory.source]}</Meta>
          {memory.status === 'active' && (
            <>
              <Meta>·</Meta>
              <Meta>{whenLastUseful(memory)}</Meta>
            </>
          )}
        </div>
        {memory.sourceNote && (
          <p className="mt-2 border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-ink-muted">
            {memory.sourceNote}
          </p>
        )}
        {memory.sourceConversationId && (
          <Link
            href={`/chat/${memory.sourceConversationId}`}
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary hover:underline"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Open the conversation this came from
          </Link>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function MemoryList({ initial }: { initial: MemoryView[] }) {
  const [memories, setMemories] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(id: string, request: () => Promise<Response>) {
    setBusyId(id);
    setError(null);
    try {
      const res = await request();
      const json = (await res.json()) as { memories?: MemoryView[]; error?: string };
      if (!res.ok) {
        setError(json.error ?? 'That did not work. Try again in a moment.');
        return;
      }
      if (json.memories) setMemories(json.memories);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyId(null);
    }
  }

  const act = (id: string, action: MemoryAction) =>
    send(id, () =>
      fetch('/api/settings/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      }),
    );

  const remove = (id: string) =>
    send(id, () =>
      fetch(`/api/settings/memories?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    );

  const suggested = memories.filter((m) => m.status === 'suggested');
  const active = memories.filter((m) => m.status === 'active');
  const archived = memories.filter((m) => m.status === 'archived');

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="rounded-card border border-border bg-rose-soft px-4 py-3 text-[13px] text-rose">
          {error}
        </div>
      )}

      {suggested.length > 0 && (
        <Panel>
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <Eyebrow>Waiting on you</Eyebrow>
            <span className="text-[12px] text-ink-faint">{suggested.length} to decide</span>
          </div>
          <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
            Zippy noticed these while you were working. Nothing here is in use yet — it only starts
            shaping answers once you keep it.
          </p>
          <div className="border-t border-border">
            {suggested.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="outline"
                      onClick={() => act(m.id, 'reject')}
                      disabled={busyId === m.id}
                    >
                      <X className="h-3.5 w-3.5" />
                      Not true
                    </Button>
                    <Button onClick={() => act(m.id, 'accept')} disabled={busyId === m.id}>
                      {busyId === m.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Keep it
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <Eyebrow>In every conversation</Eyebrow>
          <span className="text-[12px] text-ink-faint">
            {active.length} of {MEMORY_LIMIT_VIEW}
          </span>
        </div>
        <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
          Zippy carries these into every conversation, on every surface — the app, Google Chat and
          Claude. They are never quoted out loud in a group space, only used.
        </p>
        {active.length === 0 ? (
          <div className="border-t border-border px-5 py-10 text-center">
            <Brain className="mx-auto h-6 w-6 text-ink-faint" />
            <p className="mt-3 text-[13px] text-ink-muted">
              Nothing yet. Tell Zippy &ldquo;remember that…&rdquo; in a conversation, or wait — it
              will start suggesting things once it has worked with you for a few days.
            </p>
          </div>
        ) : (
          <div className="border-t border-border">
            {active.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      aria-label="Stop using this memory"
                      title="Stop using it, but keep it here"
                      onClick={() => act(m.id, 'archive')}
                      disabled={busyId === m.id}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label="Delete this memory"
                      title="Delete it for good"
                      onClick={() => remove(m.id)}
                      disabled={busyId === m.id}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </Panel>

      {archived.length > 0 && (
        <Panel>
          <div className="px-5 pt-4 pb-3">
            <Eyebrow>No longer in use</Eyebrow>
          </div>
          <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
            You put these aside, or they dropped out when you hit {MEMORY_LIMIT_VIEW}. Zippy does
            not use them — nothing is deleted behind your back.
          </p>
          <div className="border-t border-border">
            {archived.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="outline"
                      onClick={() => act(m.id, 'restore')}
                      disabled={busyId === m.id}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Use it again
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label="Delete this memory"
                      onClick={() => remove(m.id)}
                      disabled={busyId === m.id}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
