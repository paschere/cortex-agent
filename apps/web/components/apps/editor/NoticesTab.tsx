'use client';

import { saveNoticeConfigAction } from '@/lib/apps/notice-actions';
import { clsx } from 'clsx';
import { BellOff, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type AppEditorData, CARD, type EditorNoticeRole, ErrorLine } from './shared';

/**
 * «Avisos»: qué avisos automáticos recibe cada rol (0231). Nadie crea reglas:
 * la app avisa sola a quien depende de la tabla que alguien cambió. Aquí sólo
 * se enciende o apaga cada tipo por rol; lo que no se toca usa el valor por
 * defecto. Cortex lo ajusta igual con «que a Supervisor le llegue cada atención
 * nueva y al operario sólo lo que se le asigna».
 */

const KINDS = [
  { id: 'new', label: 'Algo nuevo', hint: 'Alguien registra algo en una tabla que este rol usa.' },
  { id: 'assigned', label: 'Se le asigna algo', hint: 'Le asignan un registro (campo de persona o botón «Asignar a…»).' },
  { id: 'approval', label: 'Por aprobar', hint: 'Algo queda pendiente de su aprobación.' },
  { id: 'changed', label: 'Cambia lo suyo', hint: 'Cambia el estado de un registro que esa persona creó.' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

const SEES = { all: 've todas las filas', attr: 've las filas de su cliente o sede', self: 've sus tareas', own: 've lo que registró' } as const;

export function NoticesTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const notices = data.notices;
  const [config, setConfig] = useState<Record<string, Record<string, unknown>>>(
    notices?.config.roles ?? {},
  );
  const [eff, setEff] = useState<Record<string, EditorNoticeRole>>(() =>
    Object.fromEntries((notices?.roles ?? []).map((r) => [r.roleKey, r])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(next: Record<string, Record<string, unknown>>, undo: () => void) {
    setError(null);
    start(async () => {
      const res = await saveNoticeConfigAction(data.app.id, { roles: next });
      if (!res.ok) {
        undo();
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function toggle(roleKey: string, kind: Kind, value: boolean) {
    const prevConfig = config;
    const prevEff = eff;
    const next = { ...config, [roleKey]: { ...(config[roleKey] ?? {}), [kind]: value } };
    setConfig(next);
    const cur = eff[roleKey];
    if (cur) setEff({ ...eff, [roleKey]: { ...cur, [kind]: value, custom: true } });
    save(next, () => {
      setConfig(prevConfig);
      setEff(prevEff);
    });
  }

  function reset(roleKey: string) {
    const prevConfig = config;
    const next = { ...config };
    delete next[roleKey];
    setConfig(next);
    save(next, () => setConfig(prevConfig));
  }

  if (!notices || notices.roles.length === 0)
    return (
      <section className={CARD}>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Esta app todavía no tiene roles, así que no hay a quién avisar. Crea los roles primero.
        </p>
      </section>
    );

  return (
    <section className="space-y-3">
      <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
        La app avisa sola: cuando alguien registra o cambia algo de lo que otro rol usa, cuando se
        asigna un registro y cuando algo queda por aprobar. Nunca avisa a quien hizo el cambio ni a
        quien no puede ver esa fila. Cada persona elige además si quiere todo, sólo lo suyo o nada,
        y puede silenciar.
      </p>
      {!notices.pushOn && (
        <p className="flex max-w-2xl items-start gap-2 rounded-card border border-amber/40 bg-amber-soft px-3 py-2 text-xs font-semibold text-ink">
          <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Las notificaciones del teléfono (push) están apagadas en este servidor: los avisos llegan
          a la bandeja de la app y, asignar y aprobar, por correo. Se encienden configurando las
          llaves VAPID.
        </p>
      )}
      {error && <ErrorLine error={error} />}
      {notices.roles.map((r) => {
        const e = eff[r.roleKey] ?? r;
        return (
          <div key={r.roleKey} className={clsx(CARD, 'space-y-3')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">{r.roleName}</p>
                <p className="text-micro text-ink-faint">
                  {config[r.roleKey] && Object.keys(config[r.roleKey] ?? {}).length
                    ? 'Ajustado a mano'
                    : 'Valores por defecto'}
                </p>
              </div>
              {config[r.roleKey] && Object.keys(config[r.roleKey] ?? {}).length > 0 && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => reset(r.roleKey)}
                  className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Volver a lo por defecto
                </button>
              )}
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {KINDS.map((k) => {
                const on = e[k.id];
                return (
                  <li key={k.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-card border border-border px-3 py-2">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={pending}
                        onChange={(ev) => toggle(r.roleKey, k.id, ev.target.checked)}
                        className="mt-1 h-4 w-4 accent-primary"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">{k.label}</span>
                        <span className="block text-micro text-ink-muted">{k.hint}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-micro leading-relaxed text-ink-muted">
              {r.depends.length
                ? `Usa: ${r.depends
                    .map(
                      (d) =>
                        `${d.tracker} (${SEES[d.sees]}${d.approves ? ', aprueba' : ''}${d.screens.length ? `, en ${d.screens.join(', ')}` : ''})`,
                    )
                    .join('; ')}.`
                : 'No lee ninguna tabla en sus pantallas, así que sólo recibiría asignaciones.'}
            </p>
          </div>
        );
      })}
    </section>
  );
}
