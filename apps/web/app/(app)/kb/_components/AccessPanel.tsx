'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { Building2, Loader2, Plus, User, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { accessCandidates, readSpaceAccess, shareSpace, unshareSpace } from '../actions';
import type { AccessRow, Candidate, SpaceLevel, SpaceSummary } from './types';

/**
 * QUIÉN LO VE.
 *
 * El panel que faltaba. Hasta la 0123 no hacía falta porque no había nada que
 * decidir: un espacio lo veía la empresa entera o lo veías tú, y las dos cosas
 * ya estaban dichas en el nombre. Ahora hay una tercera respuesta —«estos
 * equipos y estas personas»— y una respuesta que no se puede ver es una
 * respuesta en la que nadie confía.
 *
 * TRES DECISIONES DE FORMA, que son las que hacen que esto no dé miedo:
 *
 *   1. «Toda la empresa» es un renglón más de la lista, no un interruptor
 *      aparte. Es exactamente lo que es por dentro (una concesión de sujeto
 *      `everyone`), y ponerlo arriba del todo hace que quitarlo se lea como lo
 *      que es: dejar de estar publicado, no romper nada.
 *   2. El nivel se cambia sin confirmar y se quita CON confirmar. Bajar a
 *      alguien de 'aportar' a 'ver' es reversible en un clic; quitarle el
 *      acceso a un equipo puede dejar a diez personas sin encontrar lo que
 *      encontraban ayer.
 *   3. La lista se recarga del servidor después de cada cambio. Podría
 *      actualizarse en memoria y sería más rápido, pero entonces la pantalla
 *      mostraría lo que el navegador CREE que concedió; aquí lo que importa
 *      enseñar es lo que la base de datos concedió de verdad.
 */

const LEVEL_LABEL: Record<SpaceLevel, string> = {
  view: 'Ver',
  contribute: 'Aportar',
  admin: 'Administrar',
};

const LEVEL_HELP: Record<SpaceLevel, string> = {
  view: 'busca y lee',
  contribute: 'además guarda documentos aquí',
  admin: 'además reparte el acceso, renombra y borra',
};

function SubjectIcon({ kind }: { kind: AccessRow['subjectKind'] }) {
  const Icon = kind === 'everyone' ? Building2 : kind === 'team' ? Users : User;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />;
}

export function AccessPanel({ space }: { space: SpaceSummary }) {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [pickLevel, setPickLevel] = useState<SpaceLevel>('view');

  const load = useCallback(async () => {
    const res = await readSpaceAccess(space.id);
    if (!res.ok) {
      setError(res.error);
      setRows([]);
      return;
    }
    setError(null);
    setRows(res.rows);
  }, [space.id]);

  useEffect(() => {
    void load();
    void accessCandidates(space.id).then((res) => {
      if (res.ok) setCandidates(res.candidates);
    });
  }, [load, space.id]);

  // Un espacio personal no se abre a la empresa ni delega su administración:
  // las dos reglas viven en la base de datos (0123) y aquí sólo se dejan de
  // ofrecer, para que nadie pulse algo que va a ser rechazado.
  const isPersonal = space.kind === 'personal';
  const levels: SpaceLevel[] = isPersonal
    ? ['view', 'contribute']
    : ['view', 'contribute', 'admin'];
  const everyoneRow = rows?.find((r) => r.subjectKind === 'everyone') ?? null;
  const rest = (rows ?? []).filter((r) => r.subjectKind !== 'everyone');
  const taken = new Set(rest.map((r) => r.subjectId));
  const available = candidates.filter((c) => !taken.has(c.id));

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(key);
    setError(null);
    const res = await fn();
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setError(res.error ?? 'No se pudo cambiar el acceso.');
      return;
    }
    await load();
  }

  function add() {
    const chosen = candidates.find((c) => c.id === pick);
    if (!chosen) return;
    void run('add', async () => {
      const res = await shareSpace(space.id, { kind: chosen.kind, id: chosen.id }, pickLevel);
      if (res.ok) {
        setPick('');
        setPickLevel('view');
      }
      return res;
    });
  }

  return (
    <Panel>
      <PanelHead
        title="Quién lo ve"
        right={
          space.everyone
            ? 'toda la empresa'
            : rest.length === 0
              ? 'solo tú'
              : `${rest.length} ${rest.length === 1 ? 'acceso' : 'accesos'}`
        }
      />

      <div className="space-y-2 px-5 pb-4 pt-3">
        {!isPersonal && (
          <div className="flex items-center gap-2.5 rounded-card border border-border bg-surface-2 px-3.5 py-2.5">
            <SubjectIcon kind="everyone" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-ink">Toda la empresa</p>
              <p className="text-micro text-ink-faint">
                {everyoneRow
                  ? `Cualquiera de la organización ${LEVEL_HELP[everyoneRow.level]}.`
                  : 'Ahora mismo solo entra quien esté en la lista de abajo.'}
              </p>
            </div>
            {everyoneRow ? (
              <button
                type="button"
                disabled={busy === 'everyone'}
                onClick={() =>
                  void run('everyone', () => unshareSpace(space.id, { kind: 'everyone' }))
                }
                className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-60"
              >
                {busy === 'everyone' && <Loader2 className="h-3 w-3 animate-spin" />}
                Cerrarlo
              </button>
            ) : (
              <button
                type="button"
                disabled={busy === 'everyone'}
                onClick={() =>
                  void run('everyone', () => shareSpace(space.id, { kind: 'everyone' }, 'view'))
                }
                className="inline-flex items-center gap-1.5 rounded-pill bg-primary-soft px-2.5 py-1 text-micro font-bold text-primary transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {busy === 'everyone' && <Loader2 className="h-3 w-3 animate-spin" />}
                Abrirlo a todos
              </button>
            )}
          </div>
        )}

        {rows === null ? (
          <p className="px-1 py-2 text-xs text-ink-faint">Cargando…</p>
        ) : (
          rest.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2.5 rounded-card border border-border px-3.5 py-2.5"
            >
              <SubjectIcon kind={row.subjectKind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-ink">{row.subjectName}</p>
                <p className="text-micro text-ink-faint">
                  {row.subjectKind === 'team' ? 'Equipo' : 'Persona'} · {LEVEL_HELP[row.level]}
                </p>
              </div>

              <select
                value={row.level}
                disabled={busy === row.id}
                onChange={(e) =>
                  void run(row.id, () =>
                    shareSpace(
                      space.id,
                      { kind: row.subjectKind, id: row.subjectId },
                      e.target.value as SpaceLevel,
                    ),
                  )
                }
                className="rounded-pill border border-border bg-surface px-2.5 py-1 text-micro font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
              >
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>

              {confirming === row.id ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === row.id}
                    onClick={() =>
                      void run(row.id, () =>
                        unshareSpace(space.id, { kind: row.subjectKind, id: row.subjectId }),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-pill bg-rose px-2.5 py-1 text-micro font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {busy === row.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    Quitar el acceso
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-pill px-2 py-1 text-micro font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(row.id)}
                  aria-label={`Quitar el acceso de ${row.subjectName}`}
                  className="grid h-7 w-7 place-items-center rounded-card text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <option value="">Dar acceso a…</option>
            {available.some((c) => c.kind === 'team') && (
              <optgroup label="Equipos">
                {available
                  .filter((c) => c.kind === 'team')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {available.some((c) => c.kind === 'user') && (
              <optgroup label="Personas">
                {available
                  .filter((c) => c.kind === 'user')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>

          <select
            value={pickLevel}
            onChange={(e) => setPickLevel(e.target.value as SpaceLevel)}
            className="rounded-pill border border-border bg-surface px-2.5 py-1.5 text-micro font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {levels.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={add}
            disabled={!pick || busy === 'add'}
            className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-3 py-1.5 text-micro font-bold text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy === 'add' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Dar acceso
          </button>
        </div>

        {isPersonal && (
          <p className="pt-1 text-micro leading-relaxed text-ink-faint">
            Es tu cuaderno: puedes prestarlo, pero quien lo recibe no puede prestarlo a nadie más, y
            no se abre a toda la empresa. Para eso, mueve el documento a un espacio común.
          </p>
        )}

        {error && (
          <p className="rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}
