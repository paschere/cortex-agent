'use client';

import { formatDateTime } from '@cortex/agent-tools/src/format/display';

import { geofenceEventsAction, saveLocationSettingsAction } from '@/lib/apps/actions';
import { clsx } from 'clsx';
import { Crosshair, LocateFixed, MapPin, Plus, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { MapCircle, MapPin as Pin } from '../../views/blocks/MapCanvas';
import {
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorApp,
  ErrorLine,
  INPUT,
} from './shared';

const MapCanvas = dynamic(() => import('../../views/blocks/MapCanvas'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-sm bg-surface-2" />,
});

/**
 * «Lugares» de una aplicación (0224): la bodega, la casa de un cliente. Un punto
 * en el mapa, un radio y a quién avisar cuando alguien en turno llega o sale.
 * Se guardan dentro de los ajustes de ubicación (`saveLocationSettingsAction`);
 * el servidor los evalúa con cada posición. Sin la ubicación del equipo
 * encendida no se evalúa nada, y aquí se dice.
 */

type Place = NonNullable<EditorApp['location']['geofences']>[number];

const ON_LABEL: Record<Place['on'], string> = {
  both: 'Cuando llega y cuando sale',
  enter: 'Sólo cuando llega',
  leave: 'Sólo cuando sale',
};

function slugOf(name: string, taken: string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 26) || 'lugar';
  let id = /^[a-z]/.test(base) ? base : `l_${base}`;
  for (let n = 2; taken.includes(id) || id.length < 2; n++)
    id = `${id.replace(/_\d+$/, '').slice(0, 26)}_${n}`;
  return id;
}

export function GeofencesPanel({
  app,
  roles,
}: {
  app: EditorApp;
  roles: Array<{ key: string; name: string }>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const saved = app.location.geofences ?? [];
  const [places, setPlaces] = useState<Place[]>(saved);
  const [editing, setEditing] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [events, setEvents] = useState<
    Array<{ id: string; name: string; person: string; kind: 'enter' | 'leave'; at: string }>
  >([]);
  const dirty = JSON.stringify(places) !== JSON.stringify(saved);
  const current = places.find((p) => p.id === editing) ?? null;

  useEffect(() => {
    let alive = true;
    void geofenceEventsAction(app.id).then((res) => {
      if (alive && res.ok) setEvents(res.events);
    });
    return () => {
      alive = false;
    };
  }, [app.id]);

  const patch = (id: string, change: Partial<Place>) =>
    setPlaces((all) => all.map((p) => (p.id === id ? { ...p, ...change } : p)));

  const circles = useMemo<MapCircle[]>(
    () =>
      places.map((p) => ({
        key: p.id,
        lat: p.lat,
        lng: p.lng,
        radiusM: p.radiusM,
        label: p.name,
        selected: p.id === editing,
      })),
    [places, editing],
  );
  const pins = useMemo<Pin[]>(
    () =>
      places.map((p) => ({
        key: p.id,
        kind: 'record' as const,
        lat: p.lat,
        lng: p.lng,
        color: 'rgb(var(--primary))',
        selected: p.id === editing,
        label: p.name,
      })),
    [places, editing],
  );

  function addAt(lat: number, lng: number) {
    const name = `Lugar ${places.length + 1}`;
    const id = slugOf(
      name,
      places.map((p) => p.id),
    );
    setPlaces((all) => [
      ...all,
      {
        id,
        name,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        radiusM: 150,
        on: 'both',
        notify: { roles: [], admins: true },
      },
    ]);
    setEditing(id);
    setFitKey((k) => k + 1);
  }

  function useMyPosition() {
    setError(null);
    if (!navigator.geolocation) return setError('Este navegador no da la ubicación.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!current) return addAt(pos.coords.latitude, pos.coords.longitude);
        patch(current.id, {
          lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
          lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
        });
        setFitKey((k) => k + 1);
      },
      () => setError('No pude leer tu ubicación. Toca el mapa para elegir el punto.'),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await saveLocationSettingsAction(app.id, { geofences: places });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <section className={clsx(CARD, 'space-y-3')} aria-labelledby="geofences-title">
      <h3 id="geofences-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Crosshair className="h-4 w-4 text-ink-muted" aria-hidden /> Lugares (bodega, clientes)
      </h3>
      <p className="text-xs leading-relaxed text-ink-muted">
        Marca un punto en el mapa y un radio. Cuando alguien con el turno abierto llegue o salga, se
        registra («Ana llegó a Bodega Norte»), se ve en el mapa del equipo y se avisa a los roles
        que elijas. Salir exige alejarse un poco más que el radio, para que pararse en el borde no
        dispare avisos.
      </p>
      {!app.location.enabled && (
        <p className="rounded-card bg-amber-soft px-3 py-2 text-xs text-ink">
          La ubicación del equipo está apagada: los lugares se guardan, pero no se evalúan hasta que
          la enciendas arriba.
        </p>
      )}
      <ErrorLine error={error} />

      <div className="relative h-64 overflow-hidden rounded-sm border border-border sm:h-80">
        <MapCanvas
          pins={pins}
          circles={circles}
          fitKey={fitKey}
          picked={null}
          picking
          onSelect={(_, key) => setEditing(key)}
          onPick={(lat, lng) => (current ? patch(current.id, { lat, lng }) : addAt(lat, lng))}
        />
        <p className="pointer-events-none absolute inset-x-0 top-2 z-[500] mx-auto w-fit max-w-[90%] rounded-pill bg-ink px-3 py-1 text-micro font-semibold text-surface shadow-pop">
          {current
            ? `Toca el mapa para mover «${current.name}»`
            : 'Toca el mapa para agregar un lugar'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={useMyPosition} className={BTN_SECONDARY}>
          <LocateFixed className="h-3.5 w-3.5" aria-hidden />
          {current ? 'Mover aquí (mi ubicación)' : 'Agregar donde estoy'}
        </button>
        {current && (
          <button type="button" onClick={() => setEditing(null)} className={BTN_SECONDARY}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar otro lugar
          </button>
        )}
      </div>

      {places.length === 0 ? (
        <p className="text-xs text-ink-muted">Todavía no hay lugares.</p>
      ) : (
        <ul className="space-y-2">
          {places.map((p) => {
            const open = p.id === editing;
            return (
              <li key={p.id} className="rounded-card border border-border">
                <button
                  type="button"
                  onClick={() => setEditing(open ? null : p.id)}
                  aria-expanded={open}
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-ink"
                >
                  <MapPin className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-micro font-normal text-ink-muted">{p.radiusM} m</span>
                </button>
                {open && (
                  <div className="space-y-3 border-t border-border p-3">
                    <label className="block text-xs font-semibold text-ink">
                      Nombre
                      <input
                        value={p.name}
                        maxLength={60}
                        onChange={(e) => patch(p.id, { name: e.target.value })}
                        className={clsx(INPUT, 'mt-1 w-full')}
                      />
                    </label>
                    <label className="block text-xs font-semibold text-ink">
                      Radio: {p.radiusM} m
                      <input
                        type="range"
                        min={30}
                        max={1000}
                        step={10}
                        value={Math.min(p.radiusM, 1000)}
                        onChange={(e) => patch(p.id, { radiusM: Number(e.target.value) })}
                        className="mt-1 w-full"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-ink">
                      Cuándo se registra y avisa
                      <select
                        value={p.on}
                        onChange={(e) => patch(p.id, { on: e.target.value as Place['on'] })}
                        className={clsx(INPUT, 'mt-1 w-full')}
                      >
                        {(Object.keys(ON_LABEL) as Array<Place['on']>).map((k) => (
                          <option key={k} value={k}>
                            {ON_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <fieldset className="space-y-1">
                      <legend className="text-xs font-semibold text-ink">
                        A quién se le avisa
                      </legend>
                      <label className="flex min-h-9 items-center gap-2 text-xs text-ink">
                        <input
                          type="checkbox"
                          checked={p.notify.admins}
                          onChange={(e) =>
                            patch(p.id, { notify: { ...p.notify, admins: e.target.checked } })
                          }
                        />
                        Quien administra la empresa
                      </label>
                      {roles.map((r) => (
                        <label
                          key={r.key}
                          className="flex min-h-9 items-center gap-2 text-xs text-ink"
                        >
                          <input
                            type="checkbox"
                            checked={p.notify.roles.includes(r.key)}
                            onChange={(e) =>
                              patch(p.id, {
                                notify: {
                                  ...p.notify,
                                  roles: e.target.checked
                                    ? [...p.notify.roles, r.key]
                                    : p.notify.roles.filter((k) => k !== r.key),
                                },
                              })
                            }
                          />
                          {r.name}
                        </label>
                      ))}
                    </fieldset>
                    <label className="block text-xs font-semibold text-ink">
                      Mensaje (opcional)
                      <input
                        value={p.message ?? ''}
                        maxLength={200}
                        placeholder="{{persona}} llegó a {{lugar}}"
                        onChange={(e) => patch(p.id, { message: e.target.value || undefined })}
                        className={clsx(INPUT, 'mt-1 w-full')}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setPlaces((all) => all.filter((x) => x.id !== p.id));
                        setEditing(null);
                      }}
                      className={BTN_DANGER}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Quitar este lugar
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dirty && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={busy} className={BTN_PRIMARY}>
            Guardar lugares
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaces(saved);
              setEditing(null);
            }}
            className={BTN_SECONDARY}
          >
            Descartar
          </button>
        </div>
      )}

      {events.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink">Últimos cruces</h4>
          <ul className="space-y-0.5 text-xs text-ink-muted">
            {events.map((e) => (
              <li key={e.id}>
                <span className="font-semibold text-ink">{e.person}</span>{' '}
                {e.kind === 'enter' ? 'llegó a' : 'salió de'} {e.name} ·{' '}
                {formatDateTime(e.at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
