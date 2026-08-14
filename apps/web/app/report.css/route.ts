import { REPORT_CSS } from '@cortex/agent-tools';

/**
 * LA HOJA DE LOS INFORMES, COMO HOJA.
 *
 * `REPORT_CSS` es un VALOR de `@cortex/agent-tools`, un barril que alcanza
 * `node:dns`. Sólo puede importarlo un módulo de servidor —un componente de
 * cliente que lo importe compila en local, pasa el typecheck y rompe el build de
 * producción; está contado en `lib/reports-shape.ts`, que ya lo vivió—, y por
 * eso vivía dentro de un `<style dangerouslySetInnerHTML>` en
 * `app/(chat)/layout.tsx`.
 *
 * Eso lo ataba a UN layout. En cuanto el panel de al lado puede pintar un
 * informe hacen falta las mismas reglas en los dos, y duplicar el `<style>` era
 * duplicar cuatro kilobytes en cada carga útil de RSC de cada navegación.
 *
 * Un route handler lo arregla por los dos lados: el valor se sigue importando
 * sólo en el servidor, y lo que baja al navegador es una hoja normal, con
 * `Cache-Control: immutable`, que se pide una vez y no vuelve a viajar. El
 * `<link>` está en `app/layout.tsx`, que ya era componente de servidor.
 *
 * Cada regla está acotada a `.rp-doc`, así que no puede alcanzar el cromo de la
 * aplicación por mucho que ahora sea global: `ChartCard` y la pantalla de un
 * informe son quienes ponen esa clase.
 */

export const runtime = 'nodejs';
/**
 * Se genera una vez en el build y no depende de nada de la petición: es una
 * constante del paquete. `force-static` es lo que la convierte en un fichero en
 * lugar de en una función que se ejecuta por visita.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(REPORT_CSS, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      // El contenido sólo cambia con un despliegue, y un despliegue cambia el
      // build. `immutable` es literalmente cierto aquí.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
