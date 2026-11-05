/**
 * @cortex/app-sdk — lo que una pantalla con código usa para hablar con Cortex.
 * Todo viaja por el puente (postMessage); el servidor aplica el rol.
 */
export { cortex } from './cortex';
export { call, BRIDGE_TIMEOUT_MS, SLOW_BRIDGE_TIMEOUT_MS } from './bridge';
export { useAsync, useLocations, useQuery, useUser } from './react';
export type {
  ActionResult,
  ConfirmOptions,
  PickOptions,
  ScanOptions,
  ScanResult,
  SdkAction,
  SdkPosition,
  UploadOptions,
  UploadResult,
  QueryOptions,
  SdkField,
  SdkGeofence,
  SdkLocation,
  SdkRow,
  SdkTable,
  SdkUser,
} from './types';
