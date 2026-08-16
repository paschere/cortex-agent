import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «EJECUTAR AHORA» TIENE QUE EJECUTAR ALGO.
 *
 * Este botón estuvo roto de la peor forma que un botón puede estarlo: la ruta
 * devolvía `{ ok: true }`, la pantalla decía que sí, y no pasaba nada. El
 * evento salía sin `organizationId`, y `schedule-run.ts` —que abre la base con
 * un manejador acotado a una empresa— hacía `return { skipped: 'no workspace
 * on the event' }` y se iba. No hay error, no hay registro rojo, no hay nada
 * que mirar: sólo una rutina que no corrió.
 *
 * Importa aquí y no en cualquier sitio porque es la superficie con la que
 * alguien COMPRUEBA que una rutina funciona antes de dejarla programada. Si
 * mentir es gratis justo ahí, la respuesta a «¿esto se está ejecutando de
 * verdad?» deja de poder darse.
 *
 * Se afirma sobre el CONTENIDO del evento y no sobre el código de respuesta,
 * porque el código de respuesta ya estaba en 200 cuando el fallo existía.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.INNGEST_SIGNING_KEY = 'signkey';
});

const ORG = 'org-acme';
const USER = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const JOB = '00000000-0000-4000-8000-000000000009';

const state = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  sent: [] as Array<{ name: string; data: Record<string, unknown> }>,
  /** El id de empresa con el que se pidió el manejador acotado. */
  scopedTo: [] as string[],
}));

vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ id: USER, organization: { id: ORG } }),
}));

vi.mock('@/lib/supabase/service', () => ({
  getOrgScopedClient: (organizationId: string) => {
    state.scopedTo.push(organizationId);
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.job, error: null }) }),
        }),
      }),
    };
  },
}));

vi.mock('@/lib/inngest', () => ({
  inngest: {
    send: async (event: { name: string; data: Record<string, unknown> }) => {
      state.sent.push(event);
    },
  },
}));

const { POST } = await import('./route');

function call() {
  return POST({} as NextRequest, { params: Promise.resolve({ id: JOB }) });
}

describe('ejecutar una rutina ahora mismo', () => {
  beforeEach(() => {
    state.sent = [];
    state.scopedTo = [];
    state.job = { id: JOB, user_id: USER, is_global: false, status: 'active' };
  });

  it('manda el espacio de trabajo en el evento, que es lo único sin lo cual no corre', async () => {
    const res = await call();
    expect(res.status).toBe(200);

    expect(state.sent).toHaveLength(1);
    const event = state.sent[0];
    expect(event?.name).toBe('scheduled/job.run');
    // La afirmación que importa. Sin esto, `schedule-run.ts` se salta el turno
    // entero y esta ruta contesta que todo salió bien.
    expect(event?.data.organizationId).toBe(ORG);
    expect(event?.data.jobId).toBe(JOB);
    expect(event?.data.manual).toBe(true);
  });

  it('el evento trae el mismo espacio contra el que se leyó la rutina', async () => {
    // Si los dos se separaran, el botón podría leer la rutina de una empresa y
    // correrla contra los datos de otra — un informe perfectamente plausible
    // sobre la empresa equivocada.
    await call();
    expect(state.scopedTo).toContain(ORG);
    expect(state.sent[0]?.data.organizationId).toBe(state.scopedTo[0]);
  });

  it('una rutina ajena que no es global no se corre ni se encola', async () => {
    state.job = { id: JOB, user_id: OTHER, is_global: false, status: 'active' };
    const res = await call();
    expect(res.status).toBe(403);
    expect(state.sent).toHaveLength(0);
  });

  it('una rutina pausada lo dice en vez de encolar un evento que no hará nada', async () => {
    state.job = { id: JOB, user_id: USER, is_global: false, status: 'paused' };
    const res = await call();
    expect(res.status).toBe(409);
    expect(state.sent).toHaveLength(0);
  });
});
