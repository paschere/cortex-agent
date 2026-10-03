import { FleetScreen } from '@/components/fleet/FleetScreen';
import { parseFleetTab } from '@/lib/fleet/shape';
import {
  anomalyViews,
  eventRows,
  fleetChoices,
  fleetTiles,
  fuelRows,
  fuelSummaries,
  planRows,
  tripColumns,
  tripPresets,
  tripRows,
  vehicleCards,
} from '@/lib/fleet/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, loadFleetOverview, routeProviderConfigured } from '@cortex/agent-tools';
import {
  addVehicleAction,
  createTripAction,
  editTripCell,
  estimateRouteAction,
  logFuelAction,
  logMaintenanceAction,
  savePlanAction,
  updateVehicleAction,
} from './actions';

/**
 * Flota y rutas (migración 0196): los vehículos de la empresa con sus
 * documentos, el mantenimiento por km o por tiempo, los tanqueos con su
 * rendimiento y consumo raro, y los recorridos con su costo por km.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Flota · Cortex' };

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = parseFleetTab(q.tab);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const overview = await loadFleetOverview(db, today);
  return (
    <FleetScreen
      tab={tab}
      today={today}
      tiles={fleetTiles(overview)}
      vehicles={vehicleCards(overview)}
      plans={planRows(overview)}
      events={eventRows(overview)}
      fuel={fuelRows(overview)}
      fuelSummary={fuelSummaries(overview)}
      anomalies={anomalyViews(overview)}
      tripColumns={tripColumns(overview)}
      tripRows={tripRows(overview)}
      tripPresets={tripPresets()}
      choices={fleetChoices(overview, routeProviderConfigured())}
      handlers={{
        addVehicle: addVehicleAction,
        updateVehicle: updateVehicleAction,
        logFuel: logFuelAction,
        logMaintenance: logMaintenanceAction,
        savePlan: savePlanAction,
        estimateRoute: estimateRouteAction,
        createTrip: createTripAction,
        onEditTrip: editTripCell,
      }}
    />
  );
}
