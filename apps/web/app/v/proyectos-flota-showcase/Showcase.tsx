'use client';

import { FleetScreen, type FleetScreenProps } from '@/components/fleet/FleetScreen';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { ProjectsScreen, type ProjectsScreenProps } from '@/components/projects/ProjectsScreen';
import type { ProjectDetailView } from '@/lib/projects/shape';
import { useEffect } from 'react';

/**
 * Proyectos y flota con datos inventados (0196). Las acciones son de mentira:
 * contestan en pantalla sin tocar ninguna base.
 */

const fake = async (note: string) => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true as const, note: `(escaparate) ${note}` };
};

export function ProyectosFlotaFixture({
  dark,
  pantalla,
  projects,
  detail,
  fleet,
}: {
  dark: boolean;
  pantalla: 'proyectos' | 'proyecto' | 'flota';
  projects: Omit<ProjectsScreenProps, 'handlers' | 'tabHref'>;
  detail: ProjectDetailView;
  fleet: Omit<FleetScreenProps, 'handlers' | 'tabHref'>;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const q = `&pantalla=${pantalla}${dark ? '&modo=oscuro' : ''}`;
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      {pantalla === 'proyecto' && (
        <ProjectDetail
          view={detail}
          today={projects.today}
          handlers={{
            update: () => fake('Guardado.'),
            addTask: () => fake('Tarea agregada.'),
            toggleTask: () => fake('Listo.'),
            logTime: () => fake('Registré 6 h.'),
            deleteTime: () => fake('Borrado.'),
            addCost: () => fake('Costo cargado.'),
            linkLedger: () => fake('Gasto atado.'),
            consumeMaterial: () => fake('Salieron 4 und del inventario.'),
            addMilestone: () => fake('Hito agregado.'),
            invoice: () => fake('Factura FV-0031 en borrador.'),
          }}
        />
      )}
      {pantalla === 'proyectos' && (
        <ProjectsScreen
          {...projects}
          tabHref={(t) => `?tab=${t}${q}`}
          handlers={{
            onEdit: async () => {},
            createProject: () => fake('Abrí OS-0013.'),
            logTime: () => fake('Registré 6 h.'),
            setRate: () => fake('Guardado.'),
            openFromOpportunity: () => fake('Abrí PRY-0014.'),
          }}
        />
      )}
      {pantalla === 'flota' && (
        <FleetScreen
          {...fleet}
          tabHref={(t) => `?tab=${t}${q}`}
          handlers={{
            addVehicle: () => fake('Vehículo agregado.'),
            updateVehicle: () => fake('Guardado.'),
            logFuel: () => fake('Tanqueo registrado.'),
            logMaintenance: () => fake('Mantenimiento registrado.'),
            savePlan: () => fake('Plan guardado.'),
            estimateRoute: async () => ({ ok: true, km: 132.4, minutes: 170 }),
            createTrip: () => fake('Recorrido guardado.'),
            onEditTrip: async () => {},
          }}
        />
      )}
    </div>
  );
}
