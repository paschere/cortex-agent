// Misma razón que fingerprint.ts: la lectura de la hoja se comparte con la herramienta
// del chat `feed.connect_google_sheet`, así que vive en el paquete de herramientas.
export {
  googleSpreadsheetId,
  parseGoogleSheetRef,
  readGoogleSheetFeed,
  readGoogleSheetTab,
} from '@cortex/agent-tools/src/table-sync/feed-capture';
