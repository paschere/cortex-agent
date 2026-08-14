import 'server-only';
import { createHash } from 'node:crypto';
import { REPORT_CSS } from '@cortex/agent-tools';

/**
 * La dirección de la hoja de los informes, con su huella.
 *
 * `app/report.css/route.ts` la sirve con `Cache-Control: immutable`, y
 * `immutable` sobre una dirección fija sería mentira: cambiaría el CSS en un
 * despliegue y los navegadores seguirían con el viejo durante un año. La huella
 * lo vuelve cierto — otro contenido, otra dirección, y la anterior nunca vuelve
 * a pedirse.
 *
 * Se calcula una vez al cargar el módulo, en el servidor. `REPORT_CSS` es una
 * constante del paquete, así que esto no es una lectura: es el build mirándose
 * a sí mismo.
 */
export const REPORT_CSS_HREF = `/report.css?v=${createHash('sha256')
  .update(REPORT_CSS)
  .digest('hex')
  .slice(0, 12)}`;
