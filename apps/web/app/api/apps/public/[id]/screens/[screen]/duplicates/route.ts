/**
 * La misma ruta de /api/apps/[id]/screens/[screen]/duplicates bajo el prefijo
 * público: un usuario externo de la app no trae la cookie de better-auth.
 * La puerta real es la misma (`openScreenForApi`) y sólo ve lo de su alcance.
 */

export { POST } from '@/app/api/apps/[id]/screens/[screen]/duplicates/route';
