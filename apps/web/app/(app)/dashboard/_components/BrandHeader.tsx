import { BrandMark, BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import '@/components/views/views.css';

/**
 * EL LOGO Y EL NOMBRE DE LA EMPRESA, ARRIBA DEL INICIO.
 *
 * Discreto a propósito: una línea encima de la fecha, no una portada. Sólo
 * cuando la empresa puso su marca en /company (migración 0170); sin marca, el
 * Inicio queda como siempre. Sin logo, las iniciales en el color de la marca
 * (BrandMark), que necesitan el envoltorio `.cortex-brand` para pintarse.
 */
export function BrandHeader({ brand }: { brand: ViewBrand }) {
  return (
    <ViewBrandProvider brand={brand}>
      <BrandScope className="mb-2 flex items-center gap-2.5">
        <BrandMark brand={brand} size="sm" />
        <span className="min-w-0 truncate text-sm font-bold tracking-tight text-ink-muted">
          {brand.name}
        </span>
      </BrandScope>
    </ViewBrandProvider>
  );
}
