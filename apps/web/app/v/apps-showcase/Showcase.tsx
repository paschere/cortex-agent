'use client';

import { AppRunner } from '@/components/apps/AppRunner';
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
}: {
  marca: 'amarillo' | 'verde' | null;
  pantallas: 3 | 8;
  vacio: boolean;
}) {
  const colors = marca ? BRANDS[marca] : { primary: null, secondary: null };
  const brand = { name: 'Control en planta', logoUrl: null, ...colors };
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
