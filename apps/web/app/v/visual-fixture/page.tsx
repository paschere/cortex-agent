import { notFound } from 'next/navigation';
import { Fixture } from './Fixture';

/**
 * LA PANTALLA DE PRUEBA DEL SISTEMA VISUAL. SÓLO EN DESARROLLO.
 *
 * Pinta el shell de verdad (rail, barra superior, barra de pestañas del
 * teléfono) y los primitivos de `components/ui` con datos inventados, sin
 * sesión y sin base de datos, para poder mirar el sistema de diseño entero en
 * claro y en oscuro sin tener que iniciar sesión en local.
 *
 * Vive bajo `/v` porque ese prefijo ya es público en `middleware.ts` (las
 * vistas compartidas) y así no hay que tocar la lista de rutas públicas. Un
 * segmento estático gana a `/v/[token]`. Las carpetas que empiezan por `_`
 * (`app/__visual`) son privadas en el App Router y nunca fueron una ruta.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default function VisualFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Fixture />;
}
