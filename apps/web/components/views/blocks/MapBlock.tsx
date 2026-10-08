'use client';

import { assignTaskAction, livePeopleAction } from '@/lib/apps/location-actions';
import type { ComputedBlock, LiveTeamPerson } from '@cortex/agent-tools';
import { agoSeconds, parsePersonRef } from '@cortex/agent-tools/src/apps/location-shape';
import { clsx } from 'clsx';
import {
  BatteryLow,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  MapPinned,
  Navigation,
  Send,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { RowActions } from '../view-writes';
import type { MapPin as Pin } from './MapCanvas';
import { useRecordOpener } from './RecordDrawer';
import { Card, EmptyState, StatusChip, TONE_COLOR } from './theme';

/**
 * EL BLOQUE «MAPA».
 *
 * Dos capas, una sola vista:
 *   - REGISTROS: las filas de una tabla con ubicación (entregas, visitas,
 *     tareas), con color por estado. Vienen del cálculo de la vista, así que se
 *     refrescan con ella y llevan el scope del rol como todo lo demás.
 *   - PERSONAS en vivo: sólo si el servidor entregó `block.people` (la app
 *     comparte ubicación y este rol tiene permiso de ver). Se piden aparte, cada
 *     `pollSeconds`, con una server action que vuelve a comprobar el permiso;
 *     un enlace público o una vista fuera de una app ni siquiera la pide.
 *
 * Tocar un marcador abre una tarjeta (no un globo que tapa el mapa): del
 * registro, con «Abrir» hacia su ficha; de la persona, con «Asignar tarea».
 * Debajo van la lista de personas (para teclado y celular, donde tocar un punto
 * pequeño cuesta) y la leyenda por estado, que también filtra.
 */

type MapData = Extract<ComputedBlock, { type: 'map' }>;
type Marker = MapData['markers'][number];

const MapCanvas = dynamic(() => import('./MapCanvas'), {
  ssr: false,
  loading: () => (
    <output className="grid h-full w-full place-items-center rounded-sm bg-surface-2 text-xs text-ink-faint">
      <span className="inline-flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando el mapa…
      </span>
    </output>
  ),
});

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/**
 * Personas de mentira para el escaparate de desarrollo (`target.kind === 'demo'`,
 * /v/views-showcase, que responde 404 en producción): ahí no hay sesión ni base.
 */
function demoPeople(): LiveTeamPerson[] {
  const base = [
    ['Marta Ríos', 4.6486, -74.0997, 20],
    ['Luis Pardo', 4.7109, -74.0721, 70],
    ['Sonia Vega', 4.6097, -74.0817, 340],
    ['Andrés Gil', 4.5981, -74.1471, 1100],
  ] as const;
  return base.map(([name, lat, lng, age], i) => ({
    ref: `u:00000000-0000-4000-8000-00000000009${i}`,
    name,
    roleKey: 'terreno',
    roleName: 'Persona en terreno',
    lat,
    lng,
    accuracyM: 12 + i * 6,
    heading: null,
    speedMps: null,
    batteryPct: i === 3 ? 14 : 80 - i * 10,
    recordedAt: new Date().toISOString(),
    ageSeconds: age,
    stale: age > 300,
    onShift: true as const,
    shiftSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    self: false,
  }));
}

const PERSON_COLOR = 'rgb(var(--primary))';
const NO_TONE_COLOR = 'rgb(var(--ink-faint, 120 120 130))';

export function MapBlock({ block, target }: { block: MapData; target: SubmitTarget }) {
  const open = useRecordOpener(block.id, block.record);
  const inApp = target.kind === 'custom_app';
  const [people, setPeople] = useState<LiveTeamPerson[]>([]);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [layers, setLayers] = useState({ people: true, records: true });
  const [role, setRole] = useState('');
  const [hiddenTags, setHiddenTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ kind: 'record' | 'person'; key: string } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [assigning, setAssigning] = useState<LiveTeamPerson | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [picking, setPicking] = useState(false);

  // Las personas en vivo: una vez al abrir y cada `pollSeconds` mientras la pantalla se ve.
  const demo = target.kind === 'demo';
  const peopleOn = Boolean(block.people && (inApp || demo));
  const appId = target.kind === 'custom_app' ? target.appId : '';
  const screen = target.kind === 'custom_app' ? target.screen : '';
  const pollMs = (block.people?.pollSeconds ?? 20) * 1000;
  useEffect(() => {
    if (!peopleOn) return;
    if (demo) {
      setPeople(demoPeople());
      setLoadedAt(Date.now());
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pull = async () => {
      if (document.visibilityState === 'visible') {
        const res = await livePeopleAction(appId, screen, block.id);
        if (cancelled) return;
        if (res.ok) {
          setPeople(res.people);
          setPeopleError(null);
          setLoadedAt(Date.now());
        } else setPeopleError(res.error);
      }
      if (!cancelled) timer = setTimeout(pull, pollMs);
    };
    void pull();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        void pull();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [peopleOn, demo, appId, screen, block.id, pollMs]);

  const roles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of people) seen.set(p.roleKey, p.roleName);
    return [...seen.entries()];
  }, [people]);
  const shownPeople = layers.people ? people.filter((p) => !role || p.roleKey === role) : [];
  const shownMarkers = layers.records
    ? block.markers.filter((m) => !m.tag || !hiddenTags.includes(m.tag))
    : [];

  const pins = useMemo<Pin[]>(
    () => [
      ...shownMarkers.map((m) => ({
        key: m.id,
        kind: 'record' as const,
        lat: m.lat,
        lng: m.lng,
        color: m.tone ? TONE_COLOR[m.tone] : NO_TONE_COLOR,
        selected: selected?.kind === 'record' && selected.key === m.id,
        label: m.title,
      })),
      ...shownPeople.map((p) => ({
        key: p.ref,
        kind: 'person' as const,
        lat: p.lat,
        lng: p.lng,
        color: PERSON_COLOR,
        initials: initialsOf(p.name),
        dim: p.stale,
        selected: selected?.kind === 'person' && selected.key === p.ref,
        label: `${p.name} · ${agoSeconds(p.ageSeconds)}`,
      })),
    ],
    [shownMarkers, shownPeople, selected],
  );

  // Reencuadra cuando llegan los primeros puntos de cada capa y cuando la persona lo pide.
  const [framed, setFramed] = useState({ records: false, people: false });
  useEffect(() => {
    if (!framed.records && block.markers.length) {
      setFramed((f) => ({ ...f, records: true }));
      setFitKey((k) => k + 1);
    } else if (!framed.people && people.length) {
      setFramed((f) => ({ ...f, people: true }));
      setFitKey((k) => k + 1);
    }
  }, [block.markers.length, people.length, framed]);

  const onSelect = useCallback((kind: 'record' | 'person', key: string) => {
    setSelected({ kind, key });
  }, []);

  const record =
    selected?.kind === 'record' ? block.markers.find((m) => m.id === selected.key) : null;
  const person = selected?.kind === 'person' ? people.find((p) => p.ref === selected.key) : null;
  const empty = !block.markers.length && !people.length;

  const action = (
    <div className="view-no-print flex flex-wrap items-center gap-1.5">
      {peopleOn && (
        <LayerToggle
          on={layers.people}
          onClick={() => setLayers((l) => ({ ...l, people: !l.people }))}
          icon={<Users className="h-3.5 w-3.5" aria-hidden />}
          label={`Personas (${people.length})`}
        />
      )}
      <LayerToggle
        on={layers.records}
        onClick={() => setLayers((l) => ({ ...l, records: !l.records }))}
        icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}
        label={`${block.source} (${block.markers.length})`}
      />
      {peopleOn && roles.length > 1 && (
        <select
          aria-label="Filtrar personas por rol"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="h-11 rounded-pill border border-border bg-surface px-3.5 sm:h-8 sm:px-2.5 text-micro font-semibold text-ink-muted"
        >
          <option value="">Todos los roles</option>
          {roles.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={() => setFitKey((k) => k + 1)}
        className="view-press inline-flex h-11 items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 sm:h-8 sm:px-2.5 text-micro font-semibold text-ink-muted transition-colors hover:text-ink"
      >
        <Crosshair className="h-3.5 w-3.5" aria-hidden /> Centrar
      </button>
    </div>
  );

  return (
    <Card title={block.title} action={action}>
      <div
        className="relative h-[22rem] overflow-hidden rounded-sm border border-border sm:h-[30rem]"
        data-map-block={block.id}
      >
        <MapCanvas
          pins={pins}
          fitKey={fitKey}
          picked={picked}
          picking={picking}
          onSelect={onSelect}
          onPick={(lat, lng) => setPicked({ lat, lng })}
        />
        {picking && (
          <p className="pointer-events-none absolute inset-x-0 top-2 z-[500] mx-auto w-fit max-w-[90%] rounded-pill bg-ink px-3 py-1 text-micro font-semibold text-surface shadow-pop">
            Toca el mapa para elegir el lugar
          </p>
        )}
      </div>

      {empty && (
        <EmptyState
          className="mt-3"
          icon={<MapPinned className="h-5 w-5" aria-hidden />}
          title="Aún no hay nada en el mapa"
          hint={
            peopleOn
              ? 'Aquí saldrán las personas que inicien su turno compartiendo ubicación y los registros que tengan lugar.'
              : 'Aquí saldrán los registros de la tabla que tengan un lugar.'
          }
        />
      )}

      {block.legend.length > 0 && (
        <ul className="view-no-print mt-3 flex flex-wrap gap-1.5" aria-label="Estados">
          {block.legend.map((l) => {
            const off = hiddenTags.includes(l.label);
            return (
              <li key={l.label}>
                <button
                  type="button"
                  aria-pressed={!off}
                  onClick={() =>
                    setHiddenTags((h) => (off ? h.filter((x) => x !== l.label) : [...h, l.label]))
                  }
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-micro font-semibold transition-colors',
                    off
                      ? 'border-border text-ink-faint line-through'
                      : 'border-border-strong text-ink hover:bg-surface-2',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-pill"
                    style={{ background: TONE_COLOR[l.tone] }}
                  />
                  {l.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {(block.withoutLocation > 0 || block.hidden > 0) && (
        <p className="mt-2 text-micro text-ink-faint">
          {block.withoutLocation > 0 &&
            `${block.withoutLocation} sin lugar (no salen en el mapa). `}
          {block.hidden > 0 && `${block.hidden} más no caben en el mapa.`}
        </p>
      )}

      {record && (
        <RecordCard
          block={block}
          marker={record}
          onOpen={open ? () => open(record.id) : null}
          onClose={() => setSelected(null)}
        />
      )}

      {person && !assigning && (
        <PersonCard
          person={person}
          canAssign={Boolean(block.assign)}
          onAssign={() => setAssigning(person)}
          onClose={() => setSelected(null)}
        />
      )}

      {assigning && block.assign && (
        <AssignPanel
          block={block}
          person={assigning}
          target={target}
          picked={picked}
          picking={picking}
          onPickMode={setPicking}
          onClearPick={() => setPicked(null)}
          onDone={() => {
            setAssigning(null);
            setPicked(null);
            setPicking(false);
            window.dispatchEvent(new Event('cortex:refresh-view'));
          }}
          onCancel={() => {
            setAssigning(null);
            setPicked(null);
            setPicking(false);
          }}
        />
      )}

      {peopleOn && (
        <section className="mt-4" aria-label="Personas en turno">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-ink">
            En turno ahora
            <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted">
              {shownPeople.length}
            </span>
            {loadedAt === null && !peopleError && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-hidden />
            )}
          </h3>
          {peopleError && (
            <p className="mb-2 rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose" role="alert">
              {peopleError}
            </p>
          )}
          {!peopleError && people.length === 0 && loadedAt !== null && (
            <p className="text-xs text-ink-faint">
              Nadie está compartiendo su ubicación en este momento.
            </p>
          )}
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {shownPeople.map((p) => (
              <li key={p.ref}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected({ kind: 'person', key: p.ref });
                    setFitKey((k) => k + 1);
                  }}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-sm border px-3 py-2 text-left transition-colors hover:bg-surface-2',
                    selected?.kind === 'person' && selected.key === p.ref
                      ? 'border-primary/50 bg-primary-soft/40'
                      : 'border-border',
                  )}
                >
                  <span
                    aria-hidden
                    className={clsx(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-primary text-xs font-bold text-white',
                      p.stale && 'opacity-45',
                    )}
                  >
                    {initialsOf(p.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{p.name}</span>
                    <span className="block truncate text-micro text-ink-faint">
                      {p.roleName} · {p.stale ? 'sin señal ' : ''}
                      {agoSeconds(p.ageSeconds)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-micro text-ink-faint">
            Sólo ves a quienes aceptaron compartir su ubicación y están en turno.
          </p>
        </section>
      )}
    </Card>
  );
}

function LayerToggle({
  on,
  onClick,
  icon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        'view-press inline-flex h-11 items-center gap-1.5 rounded-pill border px-3.5 sm:h-8 sm:px-2.5 text-micro font-semibold transition-colors',
        on
          ? 'border-primary/40 bg-primary-soft text-primary-ink'
          : 'border-border bg-surface text-ink-faint',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function directionsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function RecordCard({
  block,
  marker,
  onOpen,
  onClose,
}: {
  block: MapData;
  marker: Marker;
  onOpen: (() => void) | null;
  onClose: () => void;
}) {
  const actions = block.actions;
  return (
    <div className="view-no-print mt-3 rounded-card border border-border bg-surface-2/60 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-ink">{marker.title}</p>
          {marker.subtitle && <p className="truncate text-xs text-ink-muted">{marker.subtitle}</p>}
        </div>
        <button
          type="button"
          aria-label="Cerrar la tarjeta"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {marker.tag && <StatusChip value={marker.tag} tone={marker.tone} />}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1 text-micro font-semibold text-white"
          >
            Abrir
          </button>
        )}
        <a
          href={directionsHref(marker.lat, marker.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-micro font-semibold text-ink-muted hover:text-ink"
        >
          <Navigation className="h-3 w-3" aria-hidden /> Cómo llegar
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        {actions.length > 0 && (
          <RowActions
            blockId={block.id}
            actions={actions}
            rowId={marker.id}
            rowLabel={marker.title}
          />
        )}
      </div>
    </div>
  );
}

function PersonCard({
  person,
  canAssign,
  onAssign,
  onClose,
}: {
  person: LiveTeamPerson;
  canAssign: boolean;
  onAssign: () => void;
  onClose: () => void;
}) {
  return (
    <div className="view-no-print mt-3 rounded-card border border-border bg-surface-2/60 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary text-sm font-bold text-white"
          >
            {initialsOf(person.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink">{person.name}</p>
            <p className="truncate text-xs text-ink-muted">
              {person.roleName} · en turno
              {person.shiftSince
                ? ` desde las ${new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(new Date(person.shiftSince))}`
                : ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Cerrar la tarjeta"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Última posición {person.stale ? '(sin señal) ' : ''}
        <strong className="font-semibold text-ink">{agoSeconds(person.ageSeconds)}</strong>
        {person.accuracyM !== null && ` · precisión ~${person.accuracyM} m`}
        {person.batteryPct !== null && (
          <span className="ml-1 inline-flex items-center gap-1">
            · {person.batteryPct <= 20 && <BatteryLow className="h-3 w-3 text-rose" aria-hidden />}
            batería {person.batteryPct}%
          </span>
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {canAssign && (
          <button
            type="button"
            onClick={onAssign}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-micro font-semibold text-white"
          >
            <UserRound className="h-3.5 w-3.5" aria-hidden /> Asignar tarea
          </button>
        )}
        <a
          href={directionsHref(person.lat, person.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-micro font-semibold text-ink-muted hover:text-ink"
        >
          <Navigation className="h-3 w-3" aria-hidden /> Ver en otro mapa
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}

const FIELD =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint';

function AssignPanel({
  block,
  person,
  target,
  picked,
  picking,
  onPickMode,
  onClearPick,
  onDone,
  onCancel,
}: {
  block: MapData;
  person: LiveTeamPerson;
  target: SubmitTarget;
  picked: { lat: number; lng: number } | null;
  picking: boolean;
  onPickMode: (on: boolean) => void;
  onClearPick: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const a = block.assign;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [priority, setPriority] = useState(
    a?.priority?.options[1] ?? a?.priority?.options[0] ?? '',
  );
  const [where, setWhere] = useState<'none' | 'person' | 'pick'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!a || (target.kind !== 'custom_app' && target.kind !== 'demo')) return null;
  const location =
    where === 'person'
      ? `${person.lat.toFixed(6)},${person.lng.toFixed(6)}`
      : where === 'pick' && picked
        ? `${picked.lat.toFixed(6)},${picked.lng.toFixed(6)}`
        : undefined;
  async function submit() {
    if (!a || (target.kind !== 'custom_app' && target.kind !== 'demo')) return;
    if (!title.trim()) {
      setError(`Escribe ${a.titleLabel.toLowerCase()}.`);
      return;
    }
    if (!parsePersonRef(person.ref)) return;
    setBusy(true);
    setError(null);
    if (target.kind === 'demo') {
      await new Promise((r) => setTimeout(r, 400));
      setBusy(false);
      onDone();
      return;
    }
    const res = await assignTaskAction(target.appId, target.screen, block.id, {
      person: person.ref,
      title,
      description: description || undefined,
      due: due || undefined,
      dueTime: dueTime || undefined,
      priority: priority || undefined,
      location,
    });
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.error);
  }
  return (
    <form
      className="view-no-print mt-3 space-y-3 rounded-card border border-primary/30 bg-primary-soft/30 p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-bold text-ink">Asignar tarea a {person.name}</p>
        <button
          type="button"
          aria-label="Cancelar"
          onClick={onCancel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <label className="block">
        <span className="field-label mb-1 block">{a.titleLabel}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={400}
          placeholder="Qué hay que hacer"
          className={FIELD}
        />
      </label>
      {a.descriptionLabel && (
        <label className="block">
          <span className="field-label mb-1 block">{a.descriptionLabel}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={4000}
            className={FIELD}
          />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        {a.dueLabel && (
          <label className="block">
            <span className="field-label mb-1 block">{a.dueLabel}</span>
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className={FIELD}
            />
          </label>
        )}
        {a.dueTimeLabel && (
          <label className="block">
            <span className="field-label mb-1 block">{a.dueTimeLabel}</span>
            <input
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
              className={FIELD}
            />
          </label>
        )}
      </div>
      {a.priority && (
        <label className="block">
          <span className="field-label mb-1 block">{a.priority.label}</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={FIELD}>
            {a.priority.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset>
        <legend className="field-label mb-1">Lugar</legend>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['none', 'Sin lugar'],
              ['person', `Donde está ${person.name.split(' ')[0]} ahora`],
              ['pick', 'Elegir en el mapa'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={where === value}
              onClick={() => {
                setWhere(value);
                onPickMode(value === 'pick');
                if (value !== 'pick') onClearPick();
              }}
              className={clsx(
                'rounded-pill border px-3 py-1 text-micro font-semibold transition-colors',
                where === value
                  ? 'border-primary/50 bg-primary-soft text-primary-ink'
                  : 'border-border text-ink-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {where === 'pick' && (
          <p className="mt-1.5 text-micro text-ink-faint">
            {picked
              ? `Lugar elegido: ${picked.lat.toFixed(5)}, ${picked.lng.toFixed(5)}`
              : picking
                ? 'Toca el mapa para marcarlo.'
                : 'Toca «Elegir en el mapa» y luego el mapa.'}
          </p>
        )}
      </fieldset>
      {error && (
        <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || (where === 'pick' && !picked)}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          Asignar y avisar
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-pill border border-border px-4 py-2 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
