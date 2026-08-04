'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Users, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Google Meet transcripts in a space: what has been remembered, and a way to
 * remember one more by hand.
 *
 * Deliberately shaped like `DriveSyncPanel` — the two answer the same question
 * ("is this source connected, what has it brought in, and can I pull something
 * in right now") and a person should not have to learn two layouts for it.
 *
 * The manual box exists because the half-hourly sweep only looks two days back.
 * The call worth filing is very often the one from last month that somebody has
 * only now realised matters.
 */

interface ImportedMeeting {
  id: string;
  title: string | null;
  meetingCode: string | null;
  startedAt: string | null;
  durationMinutes: number | null;
  participants: string[];
  documentId: string | null;
  importedAt: string;
  status: string;
  error: string | null;
}

interface MeetingsStatus {
  connected: boolean;
  meetings: ImportedMeeting[];
}

interface ImportResponse {
  outcome?: string;
  note?: string;
  error?: string;
}

async function fetchMeetings(spaceId: string): Promise<MeetingsStatus> {
  const r = await fetch(`/api/kb/meetings?spaceId=${spaceId}`);
  const j = (await r.json()) as Partial<MeetingsStatus>;
  return { connected: j.connected ?? false, meetings: j.meetings ?? [] };
}

/** "Mon, Mar 3, 2:00 PM" — the date an answer would cite. */
function meetingDate(iso: string | null): string {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date unknown';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MeetingImportPanel({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(
    null,
  );

  const { data } = useQuery({
    queryKey: ['kb-meetings', spaceId],
    queryFn: () => fetchMeetings(spaceId),
  });

  const connected = data?.connected ?? false;
  const meetings = data?.meetings ?? [];

  async function importMeeting() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(null);

    try {
      const r = await fetch('/api/kb/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId, meetCode: trimmed }),
      });
      const j = (await r.json()) as ImportResponse;

      if (!r.ok) {
        setMessage({ tone: 'bad', text: j.error ?? 'That meeting could not be imported.' });
        return;
      }

      const imported = j.outcome === 'imported' || j.outcome === 'updated';
      setMessage({
        tone: imported ? 'ok' : j.outcome === 'failed' ? 'bad' : 'warn',
        text: j.note ?? 'Done.',
      });
      if (imported) {
        setCode('');
        // The transcript is a document like any other, so the list above it has
        // to be told as well.
        await qc.invalidateQueries({ queryKey: ['kb-meetings', spaceId] });
        await qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
        router.refresh();
      }
    } catch {
      setMessage({
        tone: 'bad',
        text: 'The import did not run. Check the connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  const right = data
    ? connected
      ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`
      : 'Not connected'
    : null;

  return (
    <Panel>
      <PanelHead icon={<Video className="h-4 w-4" />} title="Google Meet" right={right} />
      <div className="px-5 pb-5 pt-3">
        {!data ? (
          <div className="h-9 w-40 animate-pulse rounded-pill bg-surface-2" />
        ) : !connected ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Connect Google with permission to read Meet recordings, and calls that were
              transcribed get saved here automatically — with who said what, and when.
            </p>
            <a
              href="/api/integrations/google"
              className="inline-flex items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15"
            >
              <Video className="h-3.5 w-3.5" />
              Connect Google Meet
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-[13px] leading-relaxed text-ink-muted">
                Transcribed calls from the last two days are saved to your own space automatically.
                To keep an older one — or to file it in{' '}
                <b className="font-semibold text-ink">{spaceName}</b> — paste its Meet link here.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void importMeeting();
                  }}
                  placeholder="meet.google.com/abc-defg-hij"
                  disabled={busy}
                  className="max-w-[280px]"
                  aria-label="Meet link or code"
                />
                <Button onClick={() => void importMeeting()} disabled={busy || !code.trim()}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {busy ? 'Reading the call…' : 'Import transcript'}
                </Button>
              </div>

              {message && (
                <p
                  className={
                    message.tone === 'ok'
                      ? 'mt-2.5 rounded-[10px] border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
                      : message.tone === 'warn'
                        ? 'mt-2.5 rounded-[10px] border border-amber/30 bg-amber-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
                        : 'mt-2.5 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
                  }
                >
                  {message.text}
                </p>
              )}
            </div>

            {meetings.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                {meetings.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-start gap-3 rounded-card border border-border bg-surface-2 px-3 py-2.5"
                  >
                    <IconChip tone={m.status === 'failed' ? 'rose' : 'sky'}>
                      {m.status === 'failed' ? (
                        <AlertTriangle className="h-4 w-4" />
                      ) : (
                        <Video className="h-4 w-4" />
                      )}
                    </IconChip>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">
                        {m.title ?? m.meetingCode ?? 'Untitled meeting'}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                        <span>{meetingDate(m.startedAt)}</span>
                        {m.durationMinutes != null && (
                          <>
                            <span>&middot;</span>
                            <span>{m.durationMinutes} min</span>
                          </>
                        )}
                        {m.participants.length > 0 && (
                          <>
                            <span>&middot;</span>
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {m.participants.join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                      {m.status === 'failed' && (
                        <div className="mt-1 text-xs text-rose">
                          {m.error ?? 'This one could not be saved. It will be retried.'}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] text-ink-faint">
                        Saved {relativeTime(m.importedAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
