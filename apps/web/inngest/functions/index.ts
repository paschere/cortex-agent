import { ingestDocument } from './ingest-document';
import { driveSync } from './drive-sync';
import { nightlyCleanup } from './nightly-cleanup';
import { scheduleDispatch } from './schedule-dispatch';
import { scheduleRun } from './schedule-run';

export { ingestDocument, driveSync, nightlyCleanup, scheduleDispatch, scheduleRun };
export const functions = [ingestDocument, driveSync, nightlyCleanup, scheduleDispatch, scheduleRun];
