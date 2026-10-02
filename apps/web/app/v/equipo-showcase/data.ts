import type { TrackerOption } from '@/components/team/types';
import {
  type PersonScreen,
  type TeamHrefs,
  type TeamScreen,
  buildPersonScreen,
  buildTeamScreen,
} from '@/lib/team/screen';
import { type PeriodKey, chatPath, periodFor } from '@/lib/team/shape';
import { type WorkItem, buildTeamReport } from '@cortex/agent-tools';
import {
  AS_OF,
  LAURA,
  SOFIA,
  team,
  workItems,
} from '@cortex/agent-tools/src/work/metrics.fixtures';

/**
 * Logística Andina S.A.S. (work/metrics.fixtures.ts) pasada por el motor de
 * verdad y por los mismos constructores de pantalla que usa /team. Sólo para
 * la ruta de prueba.
 */

export interface ShowcaseParams {
  pantalla: 'equipo' | 'persona' | 'semana' | 'medir';
  persona: string;
  periodo: PeriodKey;
  tipo: string | null;
  miembro: boolean;
  vacia: boolean;
  modo: string | null;
}

/**
 * Los ítems de prueba vienen todos de tablas. Para ver las otras fuentes (y
 * «Marcar hecho», que sólo sale donde hay un camino seguro), unos pocos se
 * presentan como un compromiso, algo anotado en el chat y un caso de Gerencia.
 */
function showcaseItems(): WorkItem[] {
  const as: Record<string, WorkItem['source']> = {
    'sof-open-1': { kind: 'commitment', ref: 'c-sofia-1' },
    'sof-open-2': { kind: 'chat', system: null, ref: 'h:sofia-2' },
    'lau-open-1': { kind: 'management_case', ref: 'caso-4500' },
  };
  return workItems().map((i) => {
    const source = as[i.id];
    return source
      ? {
          ...i,
          source,
          title: i.id === 'sof-open-1' ? 'Renovar póliza del camión WGY482' : i.title,
        }
      : i;
  });
}

export function showcaseHrefs(p: ShowcaseParams): TeamHrefs {
  const url = (q: Record<string, string | null | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, modo: p.modo, rol: p.miembro ? 'miembro' : null }))
      if (v) s.set(k, v);
    return `/v/equipo-showcase?${s}`;
  };
  return {
    team: ({ periodo, tipo }) => url({ pantalla: 'equipo', periodo, tipo }),
    person: (id, q) => url({ pantalla: 'persona', persona: id, periodo: q?.periodo }),
    me: (q) => url({ pantalla: 'semana', periodo: q?.periodo }),
    settings: url({ pantalla: 'medir' }),
    people: '/admin/users',
    activity: null,
    chat: chatPath,
    source: (path) => path,
  };
}

export function fixtureTeam(p: ShowcaseParams): TeamScreen {
  const items = p.vacia ? [] : showcaseItems();
  const report = buildTeamReport({
    items,
    people: team(),
    period: periodFor(p.periodo, AS_OF),
    asOf: AS_OF,
  });
  const visible = p.miembro ? new Set([SOFIA]) : null;
  return buildTeamScreen({
    report,
    items,
    periodKey: p.periodo,
    workType: p.tipo,
    today: AS_OF,
    viewer: {
      id: p.miembro ? SOFIA : 'u-admin',
      seesAll: !p.miembro,
      canReassign: !p.miembro,
      canConfigure: !p.miembro,
    },
    visibleIds: visible,
    hrefs: showcaseHrefs(p),
  });
}

export function fixturePerson(p: ShowcaseParams, self: boolean): PersonScreen | null {
  const items = p.vacia ? [] : showcaseItems();
  const people = team();
  const report = buildTeamReport({
    items,
    people,
    period: periodFor(p.periodo, AS_OF),
    asOf: AS_OF,
  });
  const personId = self ? SOFIA : p.persona || LAURA;
  return buildPersonScreen({
    report,
    history: items,
    personId,
    periodKey: p.periodo,
    today: AS_OF,
    viewer: self
      ? { id: SOFIA, seesAll: false, canEditAway: true }
      : { id: 'u-admin', seesAll: true, canEditAway: true },
    hrefs: showcaseHrefs(p),
    mode: self ? 'self' : 'person',
  });
}

export const FIXTURE_TRACKERS: TrackerOption[] = [
  {
    slug: 'despachos',
    name: 'Despachos',
    rowCount: 412,
    mappedAs: 'despacho',
    fields: [
      { key: 'guia', label: 'Guía', type: 'text' },
      {
        key: 'responsable',
        label: 'Responsable',
        type: 'select',
        options: ['Laura Gómez', 'Andrés Restrepo', 'Sofía Martínez'],
      },
      {
        key: 'estado',
        label: 'Estado',
        type: 'select',
        options: ['Pendiente', 'En ruta', 'Entregado', 'Anulado'],
      },
      { key: 'entrega', label: 'Fecha de entrega', type: 'date' },
      { key: 'guias', label: 'Guías', type: 'number' },
    ],
  },
  {
    slug: 'solicitudes',
    name: 'Solicitudes de clientes',
    rowCount: 86,
    mappedAs: null,
    fields: [
      { key: 'asunto', label: 'Asunto', type: 'text' },
      { key: 'atiende', label: 'Quién atiende', type: 'text' },
      {
        key: 'estado',
        label: 'Estado',
        type: 'select',
        options: ['Nueva', 'En curso', 'Resuelta', 'Descartada'],
      },
      { key: 'limite', label: 'Fecha límite', type: 'date' },
    ],
  },
  {
    slug: 'cobros',
    name: 'Cobros',
    rowCount: 140,
    mappedAs: null,
    fields: [
      { key: 'cliente', label: 'Cliente', type: 'text' },
      { key: 'cobrador', label: 'Cobrador', type: 'text' },
      { key: 'valor', label: 'Valor', type: 'money' },
      { key: 'vence', label: 'Vence', type: 'date' },
    ],
  },
];
