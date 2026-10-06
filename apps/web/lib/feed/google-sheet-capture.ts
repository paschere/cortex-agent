// Captura de una Google Sheet al Feed, reutilizable fuera de la ruta del Feed (chat,
// jobs). La lógica está en el paquete de herramientas porque la confirmación del chat
// sólo ejecuta herramientas del registro; aquí queda el punto de entrada de la web.
export {
  FeedCaptureError,
  captureGoogleSheetFeed,
  persistFeedCapture,
} from '@cortex/agent-tools/src/table-sync/feed-capture';
export type { CapturedSheetSummary } from '@cortex/agent-tools/src/table-sync/feed-capture';
