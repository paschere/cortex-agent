import type { ActiveOrganization } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import type { CompanyHealth } from './founder-console';
import {
  answersPercent,
  buildConsoleRows,
  filterRows,
  founderTotals,
  seatsLabel,
} from './founder-console-shape';
import type { FounderOverviewData, WorkspacePulse } from './founder-overview';

/**
 * LA CONSOLA ENSEÑA DATOS DE ADMINISTRACIÓN SÓLO DE LAS EMPRESAS PROPIAS.
 *
 * Esa es la propiedad que más importa aquí: aunque el servidor mandara por
 * error la salud de una empresa donde la cuenta es gerente, la fila no la
 * pinta. Lo demás —orden, filtro por grupo, totales— es cómo se lee.
 */

function pulse(
  workspace: ActiveOrganization,
  counts: Partial<Pick<WorkspacePulse, 'approvals' | 'actions' | 'deadlines' | 'blocked'>> = {},
): WorkspacePulse {
  return {
    workspace,
    approvals: 0,
    actions: 0,
    deadlines: 0,
    blocked: 0,
    status: 'ready',
    ...counts,
  };
}

function health(id: string, patch: Partial<CompanyHealth> = {}): CompanyHealth {
  return {
    organizationId: id,
    status: 'ready',
    createdAt: null,
    planName: 'Equipo',
    subscriptionStatus: 'active',
    seats: { used: 3, maximum: null, full: false },
    answers: { used: 50, limit: 200, ratio: 0.25, state: 'ok' },
    members: 3,
    pendingInvitations: 1,
    integrations: 2,
    routines: { active: 4, failedRecently: 0 },
    lastActivityAt: null,
    health: { tone: 'emerald', label: 'En orden' },
    ...patch,
  };
}

const personal: ActiveOrganization = {
  id: 'personal:yo',
  name: 'Espacio personal',
  slug: null,
  role: 'owner',
  kind: 'personal',
};
const acme: ActiveOrganization = {
  id: 'acme',
  name: 'Acme',
  slug: 'acme',
  role: 'owner',
  kind: 'company',
};
const beta: ActiveOrganization = {
  id: 'beta',
  name: 'Beta',
  slug: 'beta',
  role: 'owner',
  kind: 'company',
};
const cliente: ActiveOrganization = {
  id: 'cliente',
  name: 'Cliente',
  slug: 'cliente',
  role: 'admin',
  kind: 'company',
};

const overview: FounderOverviewData = {
  workspaces: [pulse(personal), pulse(acme), pulse(beta, { approvals: 2 }), pulse(cliente)],
  totals: { approvals: 2, actions: 0, deadlines: 0, blocked: 0 },
  unavailable: 0,
};

describe('filas de la consola', () => {
  const rows = buildConsoleRows(
    overview,
    {
      acme: health('acme'),
      beta: health('beta', { health: { tone: 'amber', label: 'Rutinas con fallos' } }),
      cliente: health('cliente'),
    },
    { acme: 'g1' },
    'acme',
  );

  it('ordena por dónde entrar: activa, con pendientes, propias, y el personal al final', () => {
    expect(rows.map((row) => row.id)).toEqual(['acme', 'beta', 'cliente', 'personal:yo']);
  });

  it('no pinta datos de administración de una empresa donde sólo se es gerente', () => {
    expect(rows.find((row) => row.id === 'cliente')?.health).toBeNull();
    expect(rows.find((row) => row.id === 'cliente')?.owned).toBe(false);
    expect(rows.find((row) => row.id === 'personal:yo')?.owned).toBe(false);
    expect(rows.find((row) => row.id === 'acme')?.health?.planName).toBe('Equipo');
  });

  it('filtra por grupo; «sin grupo» incluye personal y ajenas', () => {
    expect(filterRows(rows, 'g1').map((row) => row.id)).toEqual(['acme']);
    expect(filterRows(rows, 'ungrouped').map((row) => row.id)).toEqual([
      'beta',
      'cliente',
      'personal:yo',
    ]);
    expect(filterRows(rows, 'all')).toHaveLength(4);
    expect(filterRows(rows, 'grupo-borrado')).toHaveLength(0);
  });

  it('suma personas e invitaciones sólo de las propias y cuenta las que piden atención', () => {
    expect(founderTotals(rows)).toEqual({
      members: 6,
      pendingInvitations: 2,
      failedRoutines: 0,
      attention: 1,
    });
  });
});

describe('cómo se leen asientos y cupo', () => {
  it('asientos', () => {
    expect(seatsLabel(null)).toBe('—');
    expect(seatsLabel({ used: 3, maximum: 5, full: false })).toBe('3 de 5');
    expect(seatsLabel({ used: 8, maximum: null, full: false })).toBe('8 · sin tope');
  });
  it('el porcentaje se acota para dibujar, aunque el consumo pase del 100%', () => {
    expect(answersPercent(null)).toBeNull();
    expect(answersPercent({ used: 1, limit: null, ratio: null, state: 'ok' })).toBeNull();
    expect(answersPercent({ used: 236, limit: 200, ratio: 1.18, state: 'grace' })).toBe(100);
    expect(answersPercent({ used: 50, limit: 200, ratio: 0.25, state: 'ok' })).toBe(25);
  });
});
