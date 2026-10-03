/**
 * LO QUE LA PANTALLA DE FLOTA RECIBE (migración 0196).
 *
 * Módulo puro y sin dependencias: lo importan los componentes `'use client'`
 * (components/fleet) y el escaparate de desarrollo. Todo llega armado del
 * servidor (lib/fleet/views.ts): cifras como texto, tonos como palabras.
 */

export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export type ActionResult =
  | { ok: true; note?: string; href?: string }
  | { ok: false; error: string };

export type FleetTab = 'vehiculos' | 'mantenimiento' | 'combustible' | 'recorridos';

export const FLEET_TABS: Array<{ id: FleetTab; label: string }> = [
  { id: 'vehiculos', label: 'Vehículos' },
  { id: 'mantenimiento', label: 'Mantenimiento' },
  { id: 'combustible', label: 'Combustible' },
  { id: 'recorridos', label: 'Recorridos' },
];

export function parseFleetTab(raw: unknown): FleetTab {
  return FLEET_TABS.some((t) => t.id === raw) ? (raw as FleetTab) : 'vehiculos';
}

export interface Option {
  value: string;
  label: string;
}

export interface Tile {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

export interface VehicleCardView {
  id: string;
  plate: string;
  label: string | null;
  model: string | null;
  typeLabel: string | null;
  fuelLabel: string | null;
  driver: string | null;
  odometer: string | null;
  odometerOn: string | null;
  docs: Array<{ label: string; value: string; tone: Tone }>;
  attention: string[];
  kmPerGallon: string | null;
  costPerKm: string | null;
  km90: string;
  utilization: string | null;
  pendingFines: string | null;
  simitHref: string;
  plans: Option[];
  edit: {
    vehicleType: string;
    fuelType: string;
    tankGallons: string;
    driverUserId: string;
    driverName: string;
    odometerKm: string;
    label: string;
  };
}

export interface PlanRowView {
  id: string;
  vehicleId: string;
  plate: string;
  task: string;
  every: string;
  last: string;
  status: string;
  statusTone: Tone;
  reason: string;
}

export interface EventRowView {
  id: string;
  plate: string;
  date: string;
  kind: string;
  description: string;
  km: string | null;
  cost: string;
  vendor: string | null;
}

export interface FuelRowView {
  id: string;
  plate: string;
  date: string;
  gallons: string;
  amount: string;
  km: string | null;
  kmPerGallon: string | null;
  full: boolean;
  anomaly: string | null;
}

export interface FuelSummaryView {
  plate: string;
  kmPerGallon: string | null;
  median: string | null;
  costPerKm: string | null;
  anomalies: number;
  withoutOdometer: number;
}

export interface AnomalyView {
  plate: string;
  date: string;
  label: string;
  message: string;
}

export interface FleetChoices {
  vehicles: Option[];
  people: Option[];
  vehicleTypes: Option[];
  fuelTypes: Option[];
  maintenanceKinds: Option[];
  routeProvider: boolean;
}

export interface NewVehicleInput {
  plate: string;
  label: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  odometerKm: number | null;
  tankGallons: number | null;
  driverUserId: string | null;
  driverName: string | null;
  defaultPlans: boolean;
}

export interface FuelInputView {
  vehicleId: string;
  date: string;
  gallons: number;
  amount: number;
  odometerKm: number | null;
  fullTank: boolean;
  station: string | null;
}

export interface MaintenanceInputView {
  vehicleId: string;
  date: string;
  description: string;
  kind: string;
  odometerKm: number | null;
  cost: number;
  vendor: string | null;
  plan: string | null;
}

export interface PlanInputView {
  vehicleId: string;
  task: string;
  everyKm: number | null;
  everyDays: number | null;
  lastDoneKm: number | null;
  lastDoneOn: string | null;
}

export interface TripInputView {
  vehicleId: string | null;
  date: string;
  driverUserId: string | null;
  driverName: string | null;
  origin: string | null;
  stops: string[];
  destination: string | null;
  plannedKm: number | null;
  plannedSource: 'manual' | 'proveedor' | null;
  guides: string[];
  tolls: number;
  otherCosts: number;
  status: 'planeado' | 'en_ruta' | 'completado';
  km: number | null;
  note: string | null;
}

export type RouteEstimateView =
  | { ok: true; km: number; minutes: number | null }
  | { ok: false; error: string };
