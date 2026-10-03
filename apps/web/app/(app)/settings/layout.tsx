import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { SettingsCrumb } from './_components/SettingsCrumb';

/**
 * Lo común a /settings y a sus subpantallas: la salida «‹ Ajustes» de vuelta
 * al recibidor. Las subpantallas siguen siendo sus rutas de siempre.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <SettingsCrumb />
      </Suspense>
      {children}
    </>
  );
}
