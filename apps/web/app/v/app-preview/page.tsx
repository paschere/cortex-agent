import { PreviewFrame } from './PreviewFrame';

/**
 * EL MARCO DE LA «VISTA PREVIA DE LA APP» (se abre dentro de un iframe del chat).
 *
 * No trae datos: espera por postMessage el borrador que el chat le pasa (mismo
 * origen) y lo pinta con filas de ejemplo. Vive en un iframe a propósito: así
 * la app ve un ancho de pantalla de verdad (teléfono o escritorio) y su propio
 * tema, sin que el chat le cambie los estilos. Sin borrador no muestra nada.
 */
export const dynamic = 'force-dynamic';

export default function AppPreviewPage() {
  return <PreviewFrame />;
}
