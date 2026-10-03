import { buildModuleAreas, modulePageState } from '@/lib/modules/shape';
import { MODULES, type ModuleKey } from '@cortex/agent-tools/src/modules/catalog';
import { MODULE_PRESETS } from '@cortex/agent-tools/src/modules/presets';
import { notFound } from 'next/navigation';
import { ModulosFixture } from './Showcase';

/**
 * AJUSTES › MÓDULOS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /settings/modulos pide sesión; aquí se pintan los mismos componentes
 * (components/modules) con una ferretería que prendió Inventario y apagó
 * Prospección. Vive bajo `/v` por la misma razón que /v/piloto-showcase.
 *
 * Parámetros: `?pantalla=ajustes|apagado`, `?lector=1` (sin permiso para
 * cambiar), `?modo=oscuro`. En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function ModulosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const changed: Partial<Record<ModuleKey, boolean>> = { inventory: true, prospecting: false };
  const states = MODULES.map((m) => ({
    key: m.key,
    enabled: changed[m.key] ?? m.defaultOn,
    isDefault: !(m.key in changed),
  }));
  const enabled = new Set(states.filter((s) => s.enabled).map((s) => s.key));
  const areas = buildModuleAreas(states, {
    inventory: [
      'Ver el inventario',
      'Registrar un movimiento de inventario',
      'Ver qué hay que pedir',
      'Crear órdenes de compra',
      'Aprobar y enviar una orden de compra',
      'Recibir la mercancía de una orden de compra',
    ],
    finance: ['Proyectar la caja de las próximas semanas', 'Fijar la caja mínima de la empresa'],
    payables: ['Ver las facturas de proveedor por pagar', 'Programar el pago a proveedores'],
    taxes: ['Ver el calendario de impuestos', 'Marcar un impuesto presentado o pagado'],
  });
  const off = modulePageState('payroll', enabled, one('lector') !== '1');
  return (
    <ModulosFixture
      dark={one('modo') === 'oscuro'}
      pantalla={one('pantalla') === 'apagado' ? 'apagado' : 'ajustes'}
      areas={areas}
      canEdit={one('lector') !== '1'}
      offState={off.off ? off : null}
      presets={MODULE_PRESETS.map(({ key, label, examples }) => ({ key, label, examples }))}
    />
  );
}
