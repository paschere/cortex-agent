import { wakeAutomationRuns } from '@/lib/apps/automation-wake';
import { browserDocumentSink } from '@/lib/browser-download';
import { readWaitingIndex } from '@/lib/waiting';
import { setAutomationWaker, setDocumentSink, setWaitingReader } from '@cortex/agent-tools';
import * as Sentry from '@sentry/nextjs';

/**
 * Where a file fetched by a trámite goes.
 *
 * Registered here, once, because `runFlow` is reached from inside
 * `@cortex/agent-tools` (the agent's two chat tools) as well as from routes,
 * and that package cannot import Supabase Storage or Inngest. See
 * `browser/download.ts` for why this is a registration rather than an argument.
 */
setDocumentSink(browserDocumentSink());

/**
 * Qué te espera, leído por el mismo código que dibuja `/dashboard`.
 *
 * `inbox.overview` contesta la pregunta de apertura del chat, y la lectura de
 * las cuatro colas vive aquí en la app porque necesita el cliente con alcance de
 * espacio, el repositorio de encargos y las frases de confirmación. Se registra
 * en vez de importarse por lo mismo que el sumidero de arriba: un paquete no
 * puede importar de una aplicación. Ver `inbox/overview.ts` — y sobre todo, que
 * esto sea una registración es lo que impide que la herramienta se convierta en
 * un cuarto sitio que sabe filtrar aprobaciones, vencimientos, acciones y
 * encargos.
 */
setWaitingReader(readWaitingIndex);

/**
 * Quién despierta a las automatizaciones de las apps (0210). Las escrituras de
 * filas viven en el paquete (que no puede importar la cola): dejan la corrida
 * guardada y llaman a este despertador para que corra de inmediato. Sin él, el
 * barrido de cada minuto hace el mismo trabajo.
 */
setAutomationWaker(wakeAutomationRuns);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    enabled: process.env.NODE_ENV === 'production',
  });
}
