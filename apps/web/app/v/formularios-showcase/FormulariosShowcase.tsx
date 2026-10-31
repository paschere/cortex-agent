'use client';

import { FormBlock } from '@/components/views/blocks/FormBlock';
import {
  type FormDataSource,
  FormDataSourceProvider,
  type RelationOption,
} from '@/components/views/blocks/form-data-source';
import { DEFAULT_THEME, ViewThemeProvider } from '@/components/views/blocks/theme';
import { submitterFor } from '@/components/views/blocks/form-transport';
import type { ComputedBlock } from '@cortex/agent-tools';
import { useEffect, useMemo } from 'react';

/** Datos inventados. Nada de aquí sale de una base de datos ni de una API real. */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fold = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const PROVEEDORES: RelationOption[] = [
  { id: 'a1111111-1111-4111-8111-111111111111', label: 'Aerocarga del Pacífico', detail: 'Cali · Carga aérea' },
  { id: 'a2222222-2222-4222-8222-222222222222', label: 'Distribuciones Andina', detail: 'Bogotá · 300 123 4567' },
  { id: 'a3333333-3333-4333-8333-333333333333', label: 'Ferretería El Tornillo', detail: 'Medellín' },
  { id: 'a4444444-4444-4444-8444-444444444444', label: 'Logística Caribe', detail: 'Barranquilla · Courier' },
  { id: 'a5555555-5555-4555-8555-555555555555', label: 'Textiles del Valle', detail: 'Cali' },
];

const EQUIPOS: RelationOption[] = [
  { id: 'b1111111-1111-4111-8111-111111111111', label: 'Taladro percutor Bosch', detail: 'Bodega 1 · 4 disponibles' },
  { id: 'b2222222-2222-4222-8222-222222222222', label: 'Sierra circular 7 1/4"', detail: 'Bodega 1 · 2 disponibles' },
  { id: 'b3333333-3333-4333-8333-333333333333', label: 'Escalera de tijera 6 pasos', detail: 'Bodega 2' },
  { id: 'b4444444-4444-4444-8444-444444444444', label: 'Casco con barbuquejo', detail: 'EPP · 20 disponibles' },
  { id: 'b5555555-5555-4555-8555-555555555555', label: 'Chaleco reflectivo', detail: 'EPP · 35 disponibles' },
  { id: 'b6666666-6666-4666-8666-666666666666', label: 'Guantes de carnaza', detail: 'EPP · 50 disponibles' },
];

function source(scanFails: boolean): FormDataSource {
  const lists: Record<string, RelationOption[]> = { proveedor: [...PROVEEDORES], __lines: [...EQUIPOS] };
  return {
    relation: {
      async search(field, q) {
        await wait(180);
        if (typeof navigator !== 'undefined' && navigator.onLine === false)
          throw new Error('offline');
        const needle = fold(q.trim());
        return (lists[field] ?? [])
          .filter((o) => !needle || fold(`${o.label} ${o.detail ?? ''}`).includes(needle))
          .slice(0, 20);
      },
      async create(field, label) {
        await wait(350);
        const made: RelationOption = {
          id: `c${Math.random().toString(16).slice(2, 10)}-1111-4111-8111-111111111111`,
          label,
          detail: 'Nuevo',
        };
        lists[field] = [made, ...(lists[field] ?? [])];
        return made;
      },
    },
    async scan() {
      await wait(1400);
      if (scanFails) throw new Error('falla');
      return {
        read: 5,
        note: null,
        suggestions: {
          awb: { value: '729-12345675', source: 'documento' },
          piezas: { value: '14', source: 'documento' },
          peso: { value: '312.5', source: 'documento' },
          valor_unit: { value: '85000', source: 'documento' },
          tipo: { value: 'Carga', source: 'documento' },
        },
      };
    },
  };
}

function block(opts: { steps: boolean; scan: boolean; lines: boolean }): Extract<ComputedBlock, { type: 'form' }> {
  const fields = [
    { key: 'proveedor', label: 'Proveedor', type: 'relation', required: true, options: [], tracker: 'proveedores', help: 'Quien te entrega la mercancía.' },
    { key: 'fecha', label: 'Fecha de llegada', type: 'date', required: true, options: [], default: 'today' },
    { key: 'hora', label: 'Hora', type: 'time', required: false, options: [] },
    { key: 'tipo', label: 'Tipo de envío', type: 'select', required: true, options: ['Carga', 'Courier', 'Valija'] },
    { key: 'awb', label: 'Guía aérea (AWB)', type: 'text', required: true, options: [], example: '729-12345675', help: 'Está impresa arriba a la derecha de la guía.' },
    { key: 'piezas', label: 'Piezas', type: 'number', required: true, options: [], min: 1 },
    { key: 'peso', label: 'Peso (kg)', type: 'number', required: false, options: [] },
    { key: 'valor_unit', label: 'Valor por pieza', type: 'money', required: false, options: [], help: 'En pesos colombianos, sin centavos.' },
    { key: 'total', label: 'Valor total', type: 'money', required: false, options: [], formula: '[piezas] * [valor_unit]' },
    { key: 'foto', label: 'Foto de la carga', type: 'file', required: false, options: [], accept: 'image', multiple: true },
    { key: 'notas', label: 'Novedades', type: 'longtext', required: false, options: [], placeholder: 'Daños, faltantes, observaciones…' },
  ];
  return {
    type: 'form',
    id: 'recepcion',
    width: 'full',
    title: 'Recepción de mercancía',
    intro: 'Registra lo que llegó a la bodega. Si no hay señal, se guarda en el teléfono y sale solo.',
    tracker: 'recepciones',
    submitLabel: 'Registrar recepción',
    successMessage: 'Recepción registrada.',
    editWindowMinutes: 10,
    voice: 'off',
    documentScan: opts.scan,
    steps: opts.steps
      ? [
          { title: 'Quién y cuándo', fields: ['proveedor', 'fecha', 'hora', 'tipo'] },
          { title: 'La mercancía', fields: ['awb', 'piezas', 'peso', 'valor_unit', 'total'] },
          { title: 'Fotos y novedades', fields: ['foto', 'notas'] },
        ]
      : null,
    lines: opts.lines
      ? { title: 'Equipos entregados', itemLabel: 'Equipo', qtyLabel: 'Cantidad', min: 0, max: 20, photo: { label: 'Foto', required: true } }
      : null,
    fields: fields as unknown as Extract<ComputedBlock, { type: 'form' }>['fields'],
  } as unknown as Extract<ComputedBlock, { type: 'form' }>;
}

export function FormulariosShowcase({
  dark,
  operator,
  steps,
  scan,
  scanFails,
  lines,
}: {
  dark: boolean;
  operator: boolean;
  steps: boolean;
  scan: boolean;
  scanFails: boolean;
  lines: boolean;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const data = useMemo(() => source(scanFails), [scanFails]);
  const form = useMemo(() => block({ steps, scan, lines }), [steps, scan, lines]);
  const target = useMemo(() => ({ kind: 'demo' as const }), []);
  const submit = useMemo(() => submitterFor(target), [target]);
  return (
    <div className="cortex-workspace min-h-screen bg-canvas px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <ViewThemeProvider theme={{ ...DEFAULT_THEME, layout: operator ? 'operator' : 'dashboard' }}>
          <FormDataSourceProvider value={data}>
            <FormBlock block={form} target={target} submit={submit} />
          </FormDataSourceProvider>
        </ViewThemeProvider>
      </div>
    </div>
  );
}
