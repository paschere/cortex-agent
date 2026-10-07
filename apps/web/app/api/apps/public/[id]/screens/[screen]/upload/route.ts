/**
 * La misma ruta de /api/apps/[id]/screens/[screen]/upload, bajo el prefijo
 * público (`/api/apps/public`, en PUBLIC_PATHS del middleware): un usuario
 * externo de la app (0209) no trae la cookie de better-auth, así que el
 * middleware sólo lo deja pasar por aquí. La puerta real es la misma —
 * `openScreenForApi` resuelve la sesión de Cortex o la cookie de la app y
 * entrega el rol GUARDADO— y no se debilita por llegar por otro camino.
 */

export { POST } from '@/app/api/apps/[id]/screens/[screen]/upload/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
