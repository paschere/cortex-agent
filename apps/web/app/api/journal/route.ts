import { readJournal } from '@/lib/journal';
import { getOptionalSession } from '@/lib/session';
import { NextResponse } from 'next/server';

/**
 * LA JORNADA DE CORTEX, EN JSON.
 *
 * La columna de /dashboard y la pantalla de /dashboard/jornada se pintan en el
 * servidor y no necesitan esto. Existe por dos motivos concretos:
 *
 *   REFRESCAR SIN RECARGAR. La jornada cambia sola mientras alguien tiene la
 *   pantalla abierta: un trámite termina, una rutina falla, un mandato actúa.
 *   Volver a pedir la página entera para enterarse costaría el layout, la
 *   sesión y las seis consultas de /dashboard además de las doce de aquí.
 *
 *   DECIRLO FUERA DEL PRODUCTO. El mismo parte, ya redactado y ya agrupado,
 *   para un resumen por Chat o por WhatsApp — sin que ese código tenga que
 *   reimplementar ni una de las reglas de `journal-shape.ts`, que es como se
 *   acaba con dos versiones de la verdad que no coinciden.
 *
 * ===========================================================================
 * POR QUÉ 401 Y NO UNA REDIRECCIÓN
 * ===========================================================================
 * `requireSession()` redirige al login, que para un `fetch` significa recibir
 * una página HTML con estado 200 donde se esperaba JSON — el error más difícil
 * de leer que puede devolver una API. Aquí la sesión es opcional y la ausencia
 * se contesta con un 401 explícito.
 *
 * ===========================================================================
 * NO SE CACHEA, Y ESO ES DELIBERADO
 * ===========================================================================
 * Todo lo que devuelve depende de quién pregunta y de qué hora es en Bogotá. Un
 * parte cacheado es un parte que miente sobre el minuto siguiente, y el coste
 * de calcularlo es un viaje de ida y vuelta a Postgres (ver el presupuesto en
 * la cabecera de `lib/journal.ts`).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOptionalSession();
  if (!user) {
    return NextResponse.json({ error: 'Necesitas iniciar sesión.' }, { status: 401 });
  }

  try {
    const journal = await readJournal(user.organization.id, user.id, {
      isAdmin: user.role === 'org_admin',
    });
    return NextResponse.json(journal, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // Sólo llega aquí un fallo que NO es de una de las once fuentes: cada una
    // de ésas ya se recoge sola y sale en `gaps`. Un error hasta este punto es
    // la sesión, el handle de base o un fallo del propio compositor, y ninguno
    // de los tres se puede disfrazar de jornada vacía.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `No pude armar la jornada: ${detail}` },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
