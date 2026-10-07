/**
 * La misma ruta de /api/apps/[id]/push bajo el prefijo público
 * (`/api/apps/public`, en PUBLIC_PATHS del middleware): un usuario externo de
 * la app no trae la cookie de better-auth. La puerta real es la misma
 * (`openApp`) y no se debilita por llegar por otro camino.
 */

export { DELETE, GET, POST } from '@/app/api/apps/[id]/push/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
