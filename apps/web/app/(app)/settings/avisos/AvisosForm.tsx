'use client';

import { Panel } from '@/components/ui/panel';
import {
  CATEGORY_INFO,
  CHANNEL_LABEL,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
  WHATSAPP_MEMBER_CHANNEL_AVAILABLE,
  chosenChannels,
} from '@/lib/notifications/preferences-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Loader2, Moon } from 'lucide-react';
import { useState, useTransition } from 'react';

export type SavePrefsFn = (input: unknown) => Promise<{ ok: boolean; note: string }>;

/**
 * AJUSTES › AVISOS. Una tabla: cada fila una categoría de aviso, cada columna un
 * canal. Lo que no se toca queda como siempre. WhatsApp se ve pero aún no se
 * puede encender (no hay envío de Cortex al WhatsApp de una persona del
 * equipo): se explica con una etiqueta, no se esconde.
 */
export function AvisosForm({
  initial,
  save,
}: { initial: NotificationPreferences; save: SavePrefsFn }) {
  const [prefs, setPrefs] = useState<NotificationPreferences>(initial);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const toggle = (category: NotificationCategory, channel: NotificationChannel) => {
    setPrefs((p) => {
      const current = chosenChannels(p, category);
      return {
        ...p,
        channels: {
          ...p.channels,
          [category]: { ...p.channels[category], [channel]: !current[channel] },
        },
      };
    });
    setDirty(true);
    setNote(null);
  };

  const setQuiet = (patch: Partial<NotificationPreferences['quiet']>) => {
    setPrefs((p) => ({ ...p, quiet: { ...p.quiet, ...patch } }));
    setDirty(true);
    setNote(null);
  };

  const onSave = () =>
    start(async () => {
      const r = await save(prefs);
      setNote({ ok: r.ok, text: r.note });
      if (r.ok) setDirty(false);
    });

  return (
    <div className="flex max-w-[56rem] flex-col gap-6">
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <caption className="sr-only">
            Qué avisos quieres recibir, por categoría y por canal
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-ink-faint">
              <th scope="col" className="px-5 py-3 font-semibold">
                Qué
              </th>
              {NOTIFICATION_CHANNELS.map((c) => (
                <th key={c} scope="col" className="w-24 px-2 py-3 text-center font-semibold">
                  {CHANNEL_LABEL[c]}
                  {c === 'whatsapp' && !WHATSAPP_MEMBER_CHANNEL_AVAILABLE && (
                    <span className={clsx(chipClass('neutral'), 'mt-1 block text-[0.65rem]')}>
                      Próximamente
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORY_INFO.map((cat) => {
              const chosen = chosenChannels(prefs, cat.id);
              return (
                <tr key={cat.id} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-5 py-3.5 text-left align-top font-normal">
                    <span className="block font-semibold text-ink">{cat.label}</span>
                    <span className="mt-0.5 block text-[0.8125rem] leading-snug text-ink-faint">
                      {cat.description}
                    </span>
                  </th>
                  {NOTIFICATION_CHANNELS.map((ch) => {
                    const locked = ch === 'whatsapp' && !WHATSAPP_MEMBER_CHANNEL_AVAILABLE;
                    return (
                      <td key={ch} className="px-2 py-3.5 text-center align-top">
                        <label className="inline-flex cursor-pointer items-center justify-center p-1">
                          <input
                            type="checkbox"
                            checked={locked ? false : chosen[ch]}
                            disabled={locked}
                            onChange={() => toggle(cat.id, ch)}
                            aria-label={`${cat.label}: ${CHANNEL_LABEL[ch]}`}
                            className="h-[1.15rem] w-[1.15rem] accent-[rgb(var(--primary))] disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <Moon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <div className="min-w-0 flex-1">
            <label className="flex cursor-pointer items-center gap-2.5 font-semibold text-ink">
              <input
                type="checkbox"
                checked={prefs.quiet.enabled}
                onChange={(e) => setQuiet({ enabled: e.target.checked })}
                className="h-[1.15rem] w-[1.15rem] accent-[rgb(var(--primary))]"
              />
              Horas de silencio
            </label>
            <p className="mt-1 text-[0.8125rem] leading-snug text-ink-faint">
              En ese rato no suena el celular ni llega correo. La campana sigue guardando todo: al
              volver, está esperándote. Hora de Bogotá.
            </p>
          </div>
        </div>
        <div
          className={clsx(
            'flex flex-wrap items-center gap-3 pl-7 text-sm text-ink-muted',
            !prefs.quiet.enabled && 'opacity-50',
          )}
        >
          <label className="flex items-center gap-2">
            Desde
            <input
              type="time"
              value={prefs.quiet.start}
              disabled={!prefs.quiet.enabled}
              onChange={(e) => e.target.value && setQuiet({ start: e.target.value })}
              className="h-9 rounded-sm border border-border bg-surface px-2.5 text-ink"
            />
          </label>
          <label className="flex items-center gap-2">
            Hasta
            <input
              type="time"
              value={prefs.quiet.end}
              disabled={!prefs.quiet.enabled}
              onChange={(e) => e.target.value && setQuiet({ end: e.target.value })}
              className="h-9 rounded-sm border border-border bg-surface px-2.5 text-ink"
            />
          </label>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={pending || !dirty}
          className="cortex-primary-button inline-flex h-10 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Guardar
        </button>
        {note && (
          <p
            role={note.ok ? 'status' : 'alert'}
            className={clsx('text-sm font-semibold', note.ok ? 'text-emerald' : 'text-rose')}
          >
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
