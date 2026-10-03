import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { addDays } from '@/lib/datagrid/format';

/**
 * 5.000 GUÍAS DE CARGA DE MENTIRA, siempre las mismas (semilla fija), con un
 * tipo de columna de cada clase. Solo para /v/datagrid-showcase.
 */

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = [
  'Bogotá',
  'Medellín',
  'Cali',
  'Barranquilla',
  'Cartagena',
  'Bucaramanga',
  'Pereira',
  'Cúcuta',
  'Ibagué',
  'Santa Marta',
];
const CLIENTS = [
  'Ferretería El Tornillo S.A.S.',
  'Distribuidora Andina',
  'Agroinsumos del Huila',
  'Textiles Ñandú',
  'Café Origen Quindío',
  'Lácteos La Pradera',
  'Muebles Álamo',
  'Droguería Santa Fe',
  'Importadora Pacífico',
  'Panadería Doña Inés',
  'Tecnología Caribe',
  'Construcciones Ébano',
  'Floristería Orquídea',
  'Repuestos Motoruta',
  'Calzado Ávila',
  'Papelería Útil',
  'Frigorífico San Martín',
  'Cerámicas del Valle',
  'Químicos Industriales',
  'Electrodomésticos Hogar',
];
const DRIVERS = [
  'Laura Gómez',
  'Andrés Peña',
  'Camila Ríos',
  'Jhon Mosquera',
  'Valentina Ortiz',
  'Óscar Muñoz',
  'Sebastián Duarte',
  'Natalia Ceballos',
  'Iván Zuluaga',
];
const NOTES = [
  'Cliente pide entrega antes de las 10 a. m.',
  'Mercancía frágil: no apilar.',
  'Llamar al portero al llegar.',
  'Requiere cita en bodega del cliente.',
  'Factura viaja con la carga.',
  '',
  '',
  '',
];

export const STATUS_OPTIONS = [
  { value: 'por_recoger', label: 'Por recoger', tone: 'amber' as const },
  { value: 'en_transito', label: 'En tránsito', tone: 'primary' as const },
  { value: 'en_bodega', label: 'En bodega', tone: 'neutral' as const },
  { value: 'entregada', label: 'Entregada', tone: 'emerald' as const },
  { value: 'novedad', label: 'Novedad', tone: 'rose' as const },
  { value: 'devuelta', label: 'Devuelta', tone: 'rose' as const },
];

export const GUIDE_COLUMNS: GridColumn[] = [
  {
    key: 'guia',
    label: 'Guía',
    type: 'text',
    pinned: true,
    primary: true,
    required: true,
    editable: true,
    width: 150,
  },
  { key: 'cliente', label: 'Cliente', type: 'text', editable: true, width: 220, primary: true },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    options: STATUS_OPTIONS,
    editable: true,
    primary: true,
  },
  {
    key: 'origen',
    label: 'Origen',
    type: 'select',
    options: CITIES.map((c) => ({ value: c })),
    editable: true,
  },
  {
    key: 'destino',
    label: 'Destino',
    type: 'select',
    options: CITIES.map((c) => ({ value: c })),
    editable: true,
  },
  {
    key: 'flete',
    label: 'Valor flete',
    type: 'money',
    editable: true,
    primary: true,
    description: 'Lo que se le cobra al cliente, en pesos.',
  },
  { key: 'declarado', label: 'Valor declarado', type: 'money', editable: true },
  { key: 'peso', label: 'Peso (kg)', type: 'number', editable: true },
  { key: 'ocupacion', label: 'Ocupación', type: 'percent', editable: true },
  { key: 'despacho', label: 'Despacho', type: 'date', editable: true },
  { key: 'entrega', label: 'Entrega estimada', type: 'datetime', editable: true },
  { key: 'conductor', label: 'Conductor', type: 'person', editable: true },
  {
    key: 'carga',
    label: 'Tipo de carga',
    type: 'multi_select',
    options: [
      { value: 'seca', label: 'Seca' },
      { value: 'refrigerada', label: 'Refrigerada', tone: 'primary' },
      { value: 'peligrosa', label: 'Peligrosa', tone: 'rose' },
      { value: 'fragil', label: 'Frágil', tone: 'amber' },
      { value: 'sobredimensionada', label: 'Sobredimensionada' },
    ],
    editable: true,
  },
  { key: 'asegurada', label: 'Asegurada', type: 'boolean', editable: true },
  { key: 'seguimiento', label: 'Seguimiento', type: 'link', editable: true },
  { key: 'contacto', label: 'Correo de contacto', type: 'email', editable: true },
  { key: 'telefono', label: 'Teléfono', type: 'phone', editable: true },
  {
    key: 'notas',
    label: 'Observaciones',
    type: 'long_text',
    editable: true,
    description: 'Escribe «error» para ver cómo se deshace un cambio que el servidor rechaza.',
  },
];

export const TODAY = '2026-10-02';

export function makeGuides(n = 5000, seed = 7): GridRow[] {
  const r = rng(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)] as T;
  const rows: GridRow[] = [];
  for (let i = 0; i < n; i++) {
    const origen = pick(CITIES);
    let destino = pick(CITIES);
    if (destino === origen)
      destino = CITIES[(CITIES.indexOf(origen) + 3) % CITIES.length] as string;
    const despacho = addDays(TODAY, Math.floor(r() * 90) - 60);
    const status =
      despacho > TODAY
        ? r() < 0.7
          ? 'por_recoger'
          : 'en_bodega'
        : pick([
            'en_transito',
            'entregada',
            'entregada',
            'entregada',
            'novedad',
            'devuelta',
            'en_transito',
          ]);
    const peso = Math.round(20 + r() * 4800);
    const flete = Math.round((80_000 + peso * 420 + r() * 600_000) / 1000) * 1000;
    const hour = 6 + Math.floor(r() * 12);
    const entregaDay = addDays(despacho, 1 + Math.floor(r() * 4));
    const client = pick(CLIENTS);
    const slug = client
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z]+/g, '')
      .slice(0, 14);
    const carga = ['seca', 'refrigerada', 'peligrosa', 'fragil', 'sobredimensionada'].filter(
      () => r() < 0.28,
    );
    const guia = `GC-${String(240_000 + i * 7).padStart(6, '0')}`;
    rows.push({
      id: `g${i}`,
      values: {
        guia,
        cliente: client,
        estado: status,
        origen,
        destino,
        flete,
        declarado: r() < 0.15 ? null : flete * (3 + Math.floor(r() * 20)),
        peso,
        ocupacion: Math.round(r() * 1000) / 10,
        despacho,
        entrega: new Date(
          `${entregaDay}T${String(hour).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}:00-05:00`,
        ).toISOString(),
        conductor: r() < 0.08 ? null : pick(DRIVERS),
        carga: carga.length ? carga : ['seca'],
        asegurada: r() < 0.62,
        seguimiento: `https://rastreo.ejemplo.co/${guia}`,
        contacto: `logistica@${slug}.com.co`,
        telefono: `+57 3${Math.floor(r() * 30 + 10)} ${Math.floor(r() * 900 + 100)} ${Math.floor(r() * 9000 + 1000)}`,
        notas: pick(NOTES),
      },
      locked: i % 97 === 13,
    });
  }
  return rows;
}
