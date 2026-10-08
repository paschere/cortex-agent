import { BrandMark, BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';

/**
 * El marco de afuera: la franja con el color de la marca, el logo y el nombre
 * de la empresa, y «Hecho con Cortex» en pequeño. Todo dentro del envoltorio
 * de la marca, para que la contraseña y la vista lleven sus colores.
 */
export function PublicShell({
  brand,
  children,
  mobileBar = true,
}: {
  brand: ViewBrand;
  children: React.ReactNode;
  /** Falso: en el celular no se pinta la franja (una app lleva su propia cabecera compacta). */
  mobileBar?: boolean;
}) {
  return (
    <ViewBrandProvider brand={brand}>
      <BrandScope className="min-h-screen bg-canvas">
        <div
          className={`sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur print:static${mobileBar ? '' : ' hidden md:block'}`}
        >
          <span aria-hidden className="view-brand-stripe block h-1" />
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
            <span className="flex min-w-0 items-center gap-3">
              <BrandMark brand={brand} size="sm" />
              <span className="truncate text-sm font-bold text-ink">{brand.name}</span>
            </span>
            <span className="view-no-print shrink-0 text-micro text-ink-faint">
              Hecho con Cortex
            </span>
          </div>
        </div>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
      </BrandScope>
    </ViewBrandProvider>
  );
}
