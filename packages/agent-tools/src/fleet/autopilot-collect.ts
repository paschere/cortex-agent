import type { PlanItem } from '../autopilot/types';

/**
 * EL PILOTO MIRA LA FLOTA (migración 0196) — la parte pura.
 *
 * Dos avisos, los dos SÓLO PARA CONTAR (nada que aprobar: el taller lo agenda
 * una persona, y un consumo raro se pregunta al conductor, no se corrige):
 *
 *   · Mantenimiento que toca o ya se pasó, por km o por tiempo (vencimientos).
 *   · Tanqueos con un rendimiento muy por debajo de lo normal del vehículo, un
 *     odómetro que retrocede o más galones que el tanque (finanzas).
 *
 * La lectura está en ./autopilot.ts.
 */

export interface SnapshotMaintenance {
  vehicleId: string;
  plate: string;
  label: string | null;
  task: string;
  status: 'vencido' | 'pronto';
  reason: string;
  /** Lo que identifica ESTA vez (el km o el día en que toca). */
  dueKey: string;
}

export interface SnapshotFuelAnomaly {
  vehicleId: string;
  plate: string;
  logId: string;
  filledOn: string;
  message: string;
}

export interface SnapshotFleet {
  maintenance: SnapshotMaintenance[];
  fuel: SnapshotFuelAnomaly[];
}

export function collectFlota(s: SnapshotFleet | undefined, _today: string): PlanItem[] {
  if (!s) return [];
  const items: PlanItem[] = [];
  for (const m of s.maintenance.slice(0, 15)) {
    const name = m.label ? `${m.plate} (${m.label})` : m.plate;
    items.push({
      area: 'vencimientos',
      title:
        m.status === 'vencido'
          ? `${name}: ${m.task.toLowerCase()} vencido`
          : `${name}: toca ${m.task.toLowerCase()}`,
      why: `${m.reason} Agéndalo con el taller y regístralo en /flota (o dímelo) para reiniciar la cuenta.`,
      proposedAction: null,
      effect: null,
      risk: m.status === 'vencido' ? 'medium' : 'low',
      dedupeKey: `vencimientos:mantenimiento:${m.vehicleId}:${m.task.toLowerCase()}:${m.dueKey}`,
      href: '/flota?tab=mantenimiento',
    });
  }
  for (const f of s.fuel.slice(0, 10)) {
    items.push({
      area: 'finanzas',
      title: `${f.plate}: consumo de combustible raro`,
      why: `${f.message} Vale la pena preguntarle al conductor o revisar el vehículo.`,
      proposedAction: null,
      effect: null,
      risk: 'low',
      dedupeKey: `finanzas:combustible:${f.logId}`,
      href: '/flota?tab=combustible',
    });
  }
  return items;
}
