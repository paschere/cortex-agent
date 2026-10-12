import { AppPreviewPanel } from '@/components/apps/AppPreviewPanel';
import { notFound } from 'next/navigation';
import { AppsFixture } from './Showcase';
import { SAMPLE_DRAFT, sampleFixtures } from './preview-draft';
import { type TableroKind, fixturePortal, fixtureTablero } from './tablero-fixture';

/**
 * EL MARCO DE UNA APP Y SU INICIO, CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /apps y /a piden sesión y una base con la migración 0215; aquí se pintan los
 * mismos componentes (AppRunner, AppHome) con tarjetas inventadas. Vive bajo
 * `/v` porque el prefijo ya es público.
 *
 * Parámetros: `?marca=amarillo|verde` (color propio de la app),
 * `?pantallas=3|8` (cuántas pestañas), `?vacio=1` (sin tarjetas),
 * `?vista=entrada|kiosco|error|carga|desconectado|captura` (la puerta con código, el
 * kiosco con PIN, los estados de error, carga y sin señal, y la captura de campo:
 * barra sin señal, lector de códigos, firma y foto con evidencia; `&sin=0` con señal).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function AppsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  // ?preview=1: la «Vista previa de la app» del chat con un borrador de ejemplo
  // (?fila=1 abre la ficha de un envío con su flujo; ?tel=0 ancho; ?tema=oscuro).
  if (q.preview === '1')
    return (
      <div className="cortex-workspace min-h-screen bg-canvas px-4 py-6">
        <div className="mx-auto max-w-2xl rounded-card border border-border bg-surface p-4 shadow-card">
          <h1 className="mb-3 text-base font-extrabold tracking-tight text-ink">
            Vista previa de la app
          </h1>
          <AppPreviewPanel
            draft={SAMPLE_DRAFT}
            fixtures={sampleFixtures(q.fila === '1')}
            initialPhone={q.tel !== '0'}
            initialTheme={q.tema === 'oscuro' ? 'dark' : 'light'}
          />
        </div>
      </div>
    );
  // ?tablero=1|operario|supervisor|gerencia: un Tablero real calculado con filas inventadas.
  // ?portal=1[&cliente=Andina%20SAS][&pago=0]: el portal de un cliente (sin pago si pago=0).
  const tableroQ = typeof q.tablero === 'string' ? q.tablero : null;
  const tableroKind: TableroKind | null = tableroQ
    ? tableroQ === 'operario' || tableroQ === 'supervisor' || tableroQ === 'gerencia'
      ? tableroQ
      : 'gerencia'
    : null;
  const portalOn = q.portal === '1';
  return (
    <AppsFixture
      tablero={tableroKind ? fixtureTablero(tableroKind) : null}
      tableroRole={tableroKind}
      portal={
        portalOn
          ? fixturePortal(typeof q.cliente === 'string' ? q.cliente : 'Andina SAS', q.pago !== '0')
          : null
      }
      marca={q.marca === 'amarillo' || q.marca === 'verde' ? q.marca : null}
      pantallas={q.pantallas === '8' ? 8 : 3}
      vacio={q.vacio === '1'}
      vista={typeof q.vista === 'string' ? q.vista : null}
      sinSenal={typeof q.sin === 'string' ? q.sin : null}
      plegada={q.cerrada === '1'}
    />
  );
}
