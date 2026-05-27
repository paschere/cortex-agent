import { ingestDocument } from './ingest-document';
import { driveSync } from './drive-sync';
import { nightlyCleanup } from './nightly-cleanup';

export { ingestDocument, driveSync, nightlyCleanup };
export const functions = [ingestDocument, driveSync, nightlyCleanup];
