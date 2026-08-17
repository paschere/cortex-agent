import { auth } from '@/lib/auth';
import {
  createAdditionalWorkspace,
  listMemberships,
  setActiveOrganization,
} from '@/lib/organization';
import { requireSession } from '@/lib/session';
import { WORKSPACE_LIMIT } from '@/lib/workspace-limits';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * LOS ESPACIOS DE ESTA CUENTA, Y UNO NUEVO SI HACE FALTA.
 *
 * ===========================================================================
 * LA ÚNICA RUTA DEL PRODUCTO QUE MIRA A PROPÓSITO FUERA DEL INQUILINO ACTIVO
 * ===========================================================================
 * Todo lo demás en este repositorio trabaja con un manejador acotado al espacio
 * de la sesión, y `lib/tenancy-guard.test.ts` lo vigila. Esta ruta no puede: la
 * pregunta que contesta es «¿a qué OTROS espacios pertenezco?», y acotarla al
 * activo la dejaría contestando siempre «a este».
 *
 * Lo que la hace segura no es el alcance sino el eje: nunca lee datos de un
 * espacio, sólo la lista de MEMBRESÍAS de quien pregunta, y esa lista sale de
 * `ba_member` filtrada por el id de cuenta de la sesión. No hay ningún parámetro
 * del cliente que participe en esa consulta, así que no hay nada que forzar
 * desde fuera. Por eso no toca Supabase en absoluto: va por el pool de
 * better-auth, que es de quien son esas tablas.
 *
 * ===========================================================================
 * POR QUÉ EL PRODUCTO Y NO `authClient.organization` DIRECTO
 * ===========================================================================
 * El mismo argumento que ya escribió `api/team/invite/route.ts`: better-auth
 * expone `setActive` y `create` al navegador, y usarlos deja el tope de espacios
 * y la validación de membresía del lado del cliente, o sea en ningún lado. Aquí
 * el tope se dice en español con las cifras puestas, y `setActiveOrganization`
 * comprueba la membresía contra la base antes de mover la sesión.
 */

/** Lo que la barra lateral necesita para dibujar el selector. */
export async function GET() {
  const user = await requireSession();
  const session = await auth.api.getSession({ headers: await headers() });
  const baUserId = session?.user?.id;
  if (!baUserId) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });

  const workspaces = await listMemberships(baUserId);

  return NextResponse.json({
    workspaces,
    // El activo lo dice la sesión resuelta, no la lista: `requireSession` ya
    // decidió en qué espacio corre esta petición, y que las dos respuestas
    // vengan de la misma fuente evita que el selector marque una fila distinta
    // de aquella en la que la persona está trabajando.
    activeId: user.organization.id,
    canCreate: workspaces.length < WORKSPACE_LIMIT,
    limit: WORKSPACE_LIMIT,
  });
}

const CreateBody = z.object({
  name: z.string().trim().min(1, 'Ponle un nombre al espacio.').max(120),
});

/** Crear otro espacio y entrar en él. */
export async function POST(req: NextRequest) {
  await requireSession();
  const session = await auth.api.getSession({ headers: await headers() });
  const baUserId = session?.user?.id;
  if (!baUserId) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Revisa el nombre.' },
      { status: 400 },
    );
  }

  const created = await createAdditionalWorkspace(baUserId, parsed.data.name);
  if (!created.ok) {
    return NextResponse.json(
      {
        error: `Una cuenta puede tener hasta ${WORKSPACE_LIMIT} espacios de trabajo y ya los tienes todos.`,
      },
      { status: 403 },
    );
  }

  // Se entra al espacio recién creado. Crearlo y quedarse fuera obligaría a
  // abrir el selector y elegirlo, que es pedirle a alguien que confirme lo que
  // acaba de pedir.
  await setActiveOrganization(baUserId, created.workspace.id);

  return NextResponse.json(
    { ok: true, id: created.workspace.id, name: created.workspace.name },
    { status: 201 },
  );
}
