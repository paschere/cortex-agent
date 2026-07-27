import { devTaskIntake } from './dev-task-intake';
import { devTaskRun } from './dev-task-run';
import { devTaskStatus } from './dev-task-status';
import { driveSync } from './drive-sync';
import { ingestDocument } from './ingest-document';
import { nightlyCleanup } from './nightly-cleanup';
import { scheduleDispatch } from './schedule-dispatch';
import { scheduleRun } from './schedule-run';

export {
  ingestDocument,
  driveSync,
  nightlyCleanup,
  scheduleDispatch,
  scheduleRun,
  devTaskIntake,
  devTaskStatus,
};
export const functions = [
  ingestDocument,
  driveSync,
  nightlyCleanup,
  scheduleDispatch,
  scheduleRun,
  devTaskIntake,
  devTaskStatus,
  devTaskRun,
];
