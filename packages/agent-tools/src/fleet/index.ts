/**
 * Flota y rutas (migración 0196): los vehículos de la empresa (`vehicles` con
 * `in_fleet`) con su plan de mantenimiento, tanqueos, recorridos, costo por km
 * y utilización. Registra cuatro herramientas al importarse (./tools); las
 * placas, el RUNT y el SIMIT siguen siendo ../vehicles. Barril con nombres
 * propios («fleet…», «FLEET_…»).
 */

export { fleetLogFuel, fleetLogMaintenance, fleetLogTrip, fleetStatus } from './tools';

export {
  DEFAULT_PLANS as FLEET_DEFAULT_PLANS,
  FUEL_TYPES,
  FUEL_TYPE_LABEL,
  MAINTENANCE_KINDS,
  MAINTENANCE_KIND_LABEL,
  TRIP_STATUSES,
  TRIP_STATUS_LABEL,
  TRIP_STATUS_TONE,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABEL,
  formatCop as formatFleetCop,
  formatKm as formatFleetKm,
} from './shape';
export type {
  FleetTone,
  FleetVehicleRow,
  FuelLogRow,
  FuelType,
  MaintenanceEventRow,
  MaintenanceKind,
  MaintenancePlanRow,
  TripRow,
  TripStatus,
  VehicleType,
} from './shape';

export {
  FUEL_ANOMALY_LABEL,
  MAINTENANCE_STATUS_LABEL,
  fuelReport,
  maintenanceDue,
  tripCost,
  tripKm,
  utilization as fleetUtilization,
  vehicleCostPerKm,
} from './math';
export type {
  CostPerKm,
  FuelAnomaly,
  FuelReport,
  MaintenanceDue,
  MaintenanceStatus,
} from './math';

export { estimateRouteKm, routeProviderConfigured } from './routes';
export type { RouteEstimate } from './routes';

export {
  FLEET_PERIOD_DAYS,
  FleetInputError,
  addFleetVehicle,
  createTrip,
  deactivatePlan as deactivateMaintenancePlan,
  findFleetVehicle,
  listFleetVehicles,
  loadFleetOverview,
  logFuel,
  logMaintenance,
  savePlan as saveMaintenancePlan,
  updateFleetVehicle,
  updateTrip,
} from './store';
export type {
  FleetDocument,
  FleetOverview,
  FleetPlanView,
  FleetVehicleInput,
  FleetVehicleView,
  TripInput,
} from './store';

export { loadFleetSnapshot } from './autopilot';
export { collectFlota } from './autopilot-collect';
export type { SnapshotFleet } from './autopilot-collect';
