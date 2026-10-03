'use client';

import { InventoryScreen, type InventoryScreenProps } from '@/components/inventory/InventoryScreen';
import { ProductDetail } from '@/components/inventory/ProductDetail';
import { PurchaseOrderDetail } from '@/components/inventory/PurchaseOrderDetail';
import type { ActionResult, PoDetailView, ProductDetailView } from '@/lib/inventory/shape';
import { useEffect } from 'react';

/**
 * Inventario con datos inventados: la pantalla, la ficha de un producto y una
 * orden de compra. Las acciones son de mentira: contestan en pantalla sin
 * tocar ninguna base.
 */

const fake = async (note: string): Promise<ActionResult> => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, note: `(escaparate) ${note}` };
};

export function InventarioFixture({
  dark,
  pantalla,
  screen,
  product,
  order,
}: {
  dark: boolean;
  pantalla: 'lista' | 'producto' | 'orden';
  screen: Omit<InventoryScreenProps, 'handlers' | 'tabHref'>;
  product: ProductDetailView | null;
  order: PoDetailView | null;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  if (pantalla === 'producto' && product)
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        <ProductDetail
          view={product}
          handlers={{
            move: () => fake('Movimiento registrado.'),
            saveSettings: () => fake('Guardado.'),
          }}
        />
      </div>
    );

  if (pantalla === 'orden' && order)
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        <PurchaseOrderDetail
          view={order}
          handlers={{
            submit: () => fake('Por aprobar.'),
            approve: () => fake('Aprobada.'),
            send: () => fake('Enviada al proveedor con el PDF.'),
            receive: () => fake('Recibido.'),
            cancel: () => fake('Cancelada.'),
            editLines: () => fake('Orden actualizada.'),
          }}
        />
      </div>
    );

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <InventoryScreen
        {...screen}
        tabHref={(t) => `?tab=${t}${dark ? '&modo=oscuro' : ''}`}
        handlers={{
          onEdit: async () => {},
          importCsv: () => fake('3 productos nuevos, 2 actualizados y 4 existencias ajustadas.'),
          createOrders: () => fake('2 órdenes (OC-0015, OC-0016) por aprobar.'),
          setSupplier: () => fake('Proveedor fijado.'),
          addLocation: () => fake('Bodega creada.'),
          applyCount: () => fake('Conteo guardado: 2 ajustes.'),
        }}
      />
    </div>
  );
}
