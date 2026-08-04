'use client';

import { Button } from '@/components/ui/button';
import { IconChip } from '@/components/ui/panel';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Users, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ago, meetingMoment, num } from './format';

/**
 * The Meet mouth: what has already been remembered, and a way to remember one
 * more by hand. Renders bare inside `IntakePanel`.
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
        setMessage({ tone: 'bad', text: j.error ?? 'No se pudo traer esa reunión.' });
        return;
      }

      const imported = j.outcome === 'imported' || j.outcome === 'updated';
      setMessage({
        tone: imported ? 'ok' : j.outcome === 'failed' ? 'bad' : 'warn',
        text: j.note ?? 'Listo.',
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
        text: 'La importación no corrió. Revisa la conexión y vuelve a intentar.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div className="h-9 w-40 animate-pulse rounded-card bg-surface-2" />;
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Conecta Google con permiso de leer Meet y las llamadas transcritas entran solas, con quién
          dijo qué y cuándo.
        </p>
        <a
          href="/api/integrations/google"
          className="inline-flex items-center justify-center gap-1.5 rounded-card bg-primary px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-strong"
        >
          <Video className="h-3.5 w-3.5" />
          Conectar Google Meet
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Las llamadas transcritas de los últimos dos días entran solas a tu espacio. Para una más
          vieja — o para dejarla en <b className="font-semibold text-ink">{spaceName}</b> — pega
          aquí su enlace de Meet.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void importMeeting();
            }}
            placeholder="meet.google.com/abc-defg-hij"
            disabled={busy}
            aria-label="Enlace o código de Meet"
            className="tabular h-9 w-full max-w-[280px] rounded-card border border-border bg-surface px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 disabled:opacity-60"
          />
          <Button onClick={() => void importMeeting()} disabled={busy || !code.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? 'Leyendo la llamada…' : 'Traer la reunión'}
          </Button>
        </div>

        {message && (
          <p
            className={
              message.tone === 'ok'
                ? 'mt-2.5 rounded-card border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
                : message.tone === 'warn'
                  ? 'mt-2.5 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
                  : 'mt-2.5 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] leading-relaxed text-ink'
            }
          >
            {message.text}
          </p>
        )}
      </div>

      {meetings.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="field-label">Reuniones ya guardadas</div>
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
                  {m.title ?? m.meetingCode ?? 'Reunión sin título'}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
                  <span className="tabular">{meetingMoment(m.startedAt)}</span>
                  {m.durationMinutes != null && (
                    <>
                      <span>&middot;</span>
                      <span className="tabular">{num(m.durationMinutes)} min</span>
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
                  <div className="mt-1 text-[11.5px] text-rose">
                    {m.error ?? 'Esta no se pudo guardar. Se vuelve a intentar sola.'}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-ink-faint">
                  Guardada {ago(m.importedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
