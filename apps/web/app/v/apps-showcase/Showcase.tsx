'use client';

import { EntryForm } from '@/app/a/[app]/EntryForm';
import { PublicShell } from '@/app/v/[token]/PublicShell';
import { AppErrorState } from '@/components/apps/AppErrorState';
import { AppIllustration } from '@/components/apps/AppIllustration';
import { AppRunner } from '@/components/apps/AppRunner';
import { HomeSkeleton, ScreenSkeleton } from '@/components/apps/AppSkeleton';
import { KioskScreen } from '@/components/apps/KioskScreen';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ComputedHome } from '@cortex/agent-tools';

const SCREENS = [
  { slug: 'inicio', title: 'Inicio', icon: 'Home' },
  { slug: 'vuelos', title: 'Vuelos', icon: 'Truck' },
  { slug: 'registrar', title: 'Registrar', icon: 'ClipboardPlus' },
  { slug: 'guias', title: 'Guías', icon: 'ListChecks' },
  { slug: 'agenda', title: 'Agenda', icon: 'Calendar' },
  { slug: 'equipo', title: 'Equipo', icon: 'Users' },
  { slug: 'bodega', title: 'Bodega', icon: 'Package' },
  { slug: 'informes', title: 'Informes', icon: 'BarChart3' },
];

const HOME: ComputedHome = {
  greeting: { title: 'Buenos días, Ana', date: 'miércoles 7 de octubre' },
  computedAt: new Date().toISOString(),
  cards: [
    {
      id: 'hoy',
      kind: 'counter',
      tone: 'primary',
      text: 'Hoy llegan 12 vuelos',
      hint: null,
      n: 12,
      icon: null,
      screen: 'vuelos',
      filter: null,
      rows: [],
      empty: false,
      series: [4, 6, 5, 9, 8, 11, 12],
    },
    {
      id: 'entregadas',
      kind: 'counter',
      tone: 'emerald',
      text: 'Entregas a tiempo',
      hint: null,
      n: 38,
      icon: null,
      screen: 'guias',
      filter: null,
      rows: [],
      empty: false,
      series: [30, 34, 33, 36, 35, 41, 38],
    },
    {
      id: 'dup',
      kind: 'pending',
      tone: 'amber',
      text: '2 guías duplicadas por corregir',
      hint: null,
      n: 2,
      icon: null,
      screen: 'guias',
      filter: 'estado=Duplicado',
      rows: ['GU-20418 · Andina', 'GU-20431 · Pacífico'],
      empty: false,
    },
    {
      id: 'reg',
      kind: 'shortcut',
      tone: 'primary',
      text: 'Registrar atención',
      hint: 'Una atención nueva en 30 segundos',
      n: null,
      icon: 'ClipboardPlus',
      screen: 'registrar',
      filter: null,
      rows: [],
      empty: false,
    },
    {
      id: 'tarde',
      kind: 'counter',
      tone: 'sky',
      text: 'Aún no hay salidas hoy',
      hint: null,
      n: 0,
      icon: null,
      screen: 'vuelos',
      filter: null,
      rows: [],
      empty: true,
    },
    {
      id: 'ok',
      kind: 'pending',
      tone: 'amber',
      text: 'Todo al día',
      hint: null,
      n: 0,
      icon: null,
      screen: 'guias',
      filter: null,
      rows: [],
      empty: true,
    },
  ],
};

const BRANDS = {
  amarillo: { primary: '#ffd400', secondary: '#111827' },
  verde: { primary: '#047857', secondary: '#f59e0b' },
};

export function AppsFixture({
  marca,
  pantallas,
  vacio,
  vista,
}: {
  marca: 'amarillo' | 'verde' | null;
  pantallas: 3 | 8;
  vacio: boolean;
  vista: string | null;
}) {
  const colors = marca ? BRANDS[marca] : { primary: null, secondary: null };
  const brand = { name: 'Control en planta', logoUrl: null, ...colors };
  if (vista) {
    const shellBrand = { name: 'Control en planta', logoUrl: null, ...colors };
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        {vista === 'entrada' && (
          <PublicShell brand={shellBrand}>
            <EntryForm
              appId="demo"
              appName="Control en planta"
              welcome={{
                title: 'Bienvenido a Control en planta',
                text: 'Registra y consulta lo que pasa en la bodega.',
                imageUrl: null,
              }}
            />
          </PublicShell>
        )}
        {vista === 'kiosco' && (
          <PublicShell brand={shellBrand}>
            <KioskScreen
              appId="demo"
              appName="Control en planta"
              deviceName="Celular de bodega 1"
              people={[
                { id: '1', name: 'Ana Gómez' },
                { id: '2', name: 'Luis Pérez' },
                { id: '3', name: 'Marta Ríos' },
              ]}
            />
          </PublicShell>
        )}
        {vista === 'error' && (
          <ViewBrandProvider brand={shellBrand}>
            <div className="mx-auto max-w-5xl px-4 py-4">
              <AppErrorState error={new Error('demo')} reset={() => undefined} />
            </div>
          </ViewBrandProvider>
        )}
        {vista === 'carga' && (
          <div className="mx-auto max-w-5xl space-y-8 px-4 py-4">
            <HomeSkeleton />
            <ScreenSkeleton />
          </div>
        )}
        {vista === 'desconectado' && (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-16 text-center">
            <AppIllustration kind="offline" />
            <p className="text-base font-bold text-ink">Sin señal</p>
            <p className="text-sm text-ink-muted">
              Lo que registres se guarda y se envía al volver.
            </p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <ViewBrandProvider brand={brand}>
        <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
          <AppRunner
            app={{ id: 'demo', slug: 'demo', name: 'Control en planta', icon: '🚚' }}
            screens={SCREENS.slice(0, pantallas)}
            current="inicio"
            role={{ key: 'operario', name: 'Operario' }}
            readOnly={false}
            canExport={false}
            canManage={false}
            home={vacio ? { ...HOME, cards: [] } : HOME}
            title="Inicio"
            basePath="/a/demo"
          />
        </div>
      </ViewBrandProvider>
    </div>
  );
}
