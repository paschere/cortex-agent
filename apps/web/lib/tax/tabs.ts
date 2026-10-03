import type { TaxTabLinks } from '@/components/tax/types';

/** Los enlaces de las tres pestañas de /impuestos, dentro del espacio. */
export function taxTabLinks(href: (path: string) => string, year?: number): TaxTabLinks {
  return {
    calendario: href('/impuestos'),
    certificados: href(year ? `/impuestos/certificados?anio=${year}` : '/impuestos/certificados'),
    exogena: href('/impuestos/exogena'),
  };
}
