'use client';

import type { ApiWizardClient } from '@/app/(app)/feed/ConnectApiWizard';
import { Feed } from '@/app/(app)/feed/Feed';
import type { FeedClient } from '@/app/(app)/feed/feed-client';
import { recommendFeedUse } from '@/lib/feed/intelligence';
import type { FeedDetail, FeedEntry } from '@/lib/feed/shared';
import type { FeedSourceSummary } from '@/lib/feed/source-management';
import { useEffect, useMemo } from 'react';

const NOW = '2026-10-02T15:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const purge = (minutes: number) => new Date(Date.parse(at(minutes)) + 7 * 86_400_000).toISOString();

type Seed = FeedEntry & { text: string; tables: FeedDetail['feed_tables'] };

function entry(id: string, filename: string, minutes: number, patch: Partial<Seed> = {}): Seed {
  return {
    id,
    filename,
    feed_kind: 'file',
    source_url: null,
    created_at: at(minutes),
    purge_at: purge(minutes),
    byte_size: 0,
    conversation_id: null,
    promoted_document_id: null,
    feed_truncated: false,
    feed_source_id: null,
    text: '',
    tables: null,
    ...patch,
  };
}

const DESPACHOS = [
  ['Guía', 'Fecha', 'Cliente', 'Origen', 'Destino', 'Peso (kg)', 'Valor flete', 'Estado'],
  [
    '729-1182 4410',
    '2026-09-28',
    'Flores del Campo',
    'Bogotá',
    'Miami',
    412,
    3_850_000,
    'Entregado',
  ],
  [
    '145-2290 1187',
    '2026-09-29',
    'Café Altura',
    'Medellín',
    'Madrid',
    1080,
    9_120_000,
    'En tránsito',
  ],
  [
    '729-1182 4421',
    '2026-09-30',
    'Flores del Campo',
    'Bogotá',
    'Ámsterdam',
    655,
    5_310_000,
    'En bodega',
  ],
  [
    '045-8812 0032',
    '2026-10-01',
    'Textiles Nova',
    'Cali',
    'Ciudad de México',
    230,
    1_980_000,
    'Por despachar',
  ],
  [
    '145-2290 1203',
    '2026-10-01',
    'Café Altura',
    'Medellín',
    'Hamburgo',
    940,
    8_700_000,
    'Por despachar',
  ],
];

const CARTERA = [
  ['Factura', 'NIT', 'Cliente', 'Vence', 'Saldo', 'Días vencida'],
  ['FE-10231', '900.123.456-7', 'Flores del Campo', '2026-09-10', 12_400_000, 22],
  ['FE-10244', '901.552.010-3', 'Café Altura', '2026-09-25', 7_950_000, 7],
  ['FE-10260', '800.441.902-1', 'Textiles Nova', '2026-10-15', 3_200_000, 0],
];

const SEEDS: Seed[] = [
  entry('e1', 'Despachos septiembre.xlsx', 25, {
    byte_size: 48_210,
    feed_source_id: 's-desp',
    tables: [
      { name: 'Despachos', rows: DESPACHOS },
      {
        name: 'Tarifas',
        rows: [
          ['Ruta', 'Kg'],
          ['BOG-MIA', 9300],
        ],
      },
    ],
    text: 'Despachos septiembre',
  }),
  entry('e2', 'Contrato marco — Flores del Campo.pdf', 70, {
    byte_size: 1_284_000,
    conversation_id: 'c1',
    text: 'CONTRATO MARCO DE TRANSPORTE DE CARGA AÉREA\n\nEntre TRANSPORTES ANDINOS S.A.S., NIT 900.765.432-1, y FLORES DEL CAMPO S.A.S., NIT 900.123.456-7, se celebra el presente contrato…\n\nCLÁUSULA TERCERA. TARIFAS. Las tarifas por kilogramo se liquidan según el anexo 1 y se reajustan cada seis (6) meses…\n\nCLÁUSULA QUINTA. PLAZO DE PAGO. Treinta (30) días calendario desde la radicación de la factura electrónica.',
  }),
  entry('e3', 'Cartera vencida — Siigo.csv', 60 * 5, {
    byte_size: 6_402,
    promoted_document_id: 'doc-1',
    tables: [{ name: 'Cartera', rows: CARTERA }],
    text: 'Cartera vencida',
  }),
  entry('e4', 'Despachos 2026 (Google Sheets)', 60 * 26, {
    feed_kind: 'url',
    source_url: 'https://docs.google.com/spreadsheets/d/1AbCdEf/edit',
    byte_size: 92_880,
    feed_source_id: 's-sheet',
    tables: [{ name: 'Hoja 1', rows: DESPACHOS }],
    text: 'Despachos 2026',
  }),
  entry('e4b', 'Despachos 2026 (Google Sheets)', 60 * 50, {
    feed_kind: 'url',
    source_url: 'https://docs.google.com/spreadsheets/d/1AbCdEf/edit',
    byte_size: 90_100,
    feed_source_id: 's-sheet',
    tables: [{ name: 'Hoja 1', rows: DESPACHOS.slice(0, 4) }],
    text: 'Despachos 2026',
  }),
  entry('e5', 'ERP · pedidos abiertos', 60 * 30, {
    feed_kind: 'api',
    byte_size: 18_330,
    feed_source_id: 's-erp',
    tables: [
      {
        name: 'Pedidos',
        rows: [
          ['Pedido', 'Cliente', 'Fecha', 'Total'],
          ['PO-5521', 'Café Altura', '2026-09-30', 9_120_000],
          ['PO-5522', 'Textiles Nova', '2026-10-01', 1_980_000],
        ],
      },
    ],
    text: 'Pedidos abiertos',
  }),
  entry('e6', 'Notas reunión con Café Altura', 60 * 48, {
    feed_kind: 'text',
    byte_size: 1_120,
    conversation_id: 'c2',
    text: 'Reunión 30 sep con Café Altura (Juliana):\n- Quieren subir de 2 a 4 despachos semanales a Europa desde noviembre.\n- Piden tarifa fija por kg para Hamburgo.\n- Pendiente: enviar propuesta antes del viernes.',
  }),
  entry('e7', 'Política de viáticos 2026.docx', 60 * 24 * 3, {
    byte_size: 210_400,
    promoted_document_id: 'doc-2',
    text: 'POLÍTICA DE VIÁTICOS\n\n1. Alcance: aplica a todo el personal que viaje por la empresa.\n2. Topes diarios: alojamiento hasta $280.000; alimentación hasta $95.000…',
  }),
  entry('e8', 'Tarifas aerolíneas Q4.pdf', 60 * 24 * 9, {
    byte_size: 640_000,
    feed_truncated: true,
    text: 'TARIFAS Q4 2026 — AVIANCA CARGO / LATAM CARGO\nBOG-MIA  USD 2.35/kg …',
  }),
  entry('e9', 'https://www.dian.gov.co/normatividad', 60 * 24 * 5, {
    feed_kind: 'url',
    source_url: 'https://www.dian.gov.co/normatividad',
    byte_size: 34_000,
    text: 'Normatividad DIAN — resoluciones de facturación electrónica…',
  }),
];

const SOURCES: FeedSourceSummary[] = [
  {
    id: 's-sheet',
    kind: 'google_sheet',
    name: 'Despachos 2026 (Google Sheets)',
    latestAttachmentId: 'e4',
    status: 'ok',
    lastCheckedAt: at(60 * 26),
    error: null,
    enabled: true,
    freshnessMinutes: 1440,
    webhookEnabled: false,
    lastWebhookAt: null,
    health: {
      state: 'healthy',
      label: 'Al día',
      detail: 'Capturada hace un día',
      affectedActivations: 2,
      needsReview: 0,
    },
  },
  {
    id: 's-erp',
    kind: 'api',
    name: 'ERP · pedidos abiertos',
    latestAttachmentId: 'e5',
    status: 'error',
    lastCheckedAt: at(180),
    error: 'El ERP no respondió (503). Se conserva la última captura.',
    enabled: true,
    freshnessMinutes: 60,
    webhookEnabled: false,
    lastWebhookAt: null,
    health: {
      state: 'error',
      label: 'Con error',
      detail: 'La última actualización falló',
      affectedActivations: 1,
      needsReview: 1,
    },
  },
  {
    id: 's-desp',
    kind: 'file',
    name: 'Despachos septiembre.xlsx',
    latestAttachmentId: 'e1',
    status: 'ready',
    lastCheckedAt: at(25),
    error: null,
    enabled: true,
    freshnessMinutes: 1440,
    webhookEnabled: false,
    lastWebhookAt: null,
  },
];

const NO_SEEDS: Seed[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryClient(seeds: Seed[]): FeedClient {
  const rows = new Map(seeds.map((s) => [s.id, s]));
  const strip = ({ text: _t, tables: _x, ...e }: Seed): FeedEntry => e;
  return {
    async list() {
      return [...rows.values()].map(strip);
    },
    async detail(id) {
      await wait(250);
      const s = rows.get(id);
      if (!s) throw new Error('La entrada no existe o ya venció.');
      return {
        ...strip(s),
        extracted_text: s.text,
        feed_tables: s.tables,
        recommendation: recommendFeedUse({
          name: s.filename,
          text: s.text,
          tables: s.tables ?? [],
        }),
      };
    },
    async add(form) {
      await wait(500);
      const kind = String(form.get('kind'));
      const file = form.get('file');
      const id = `n${rows.size + 1}`;
      const name =
        file instanceof File
          ? file.name
          : kind === 'url'
            ? String(form.get('url'))
            : String(form.get('title') || 'Nota de consulta');
      const s = entry(id, name, 0, {
        feed_kind: kind === 'url' ? 'url' : kind === 'text' ? 'text' : 'file',
        source_url: kind === 'url' ? String(form.get('url')) : null,
        byte_size: file instanceof File ? file.size : String(form.get('text') ?? '').length,
        text: kind === 'text' ? String(form.get('text')) : 'Contenido leído (escaparate).',
      });
      rows.set(id, s);
      return { entry: strip(s) };
    },
    async consult() {
      throw new Error('En el escaparate no se abre el chat.');
    },
    async promote(id) {
      await wait(300);
      const s = rows.get(id);
      if (s) s.promoted_document_id = `doc-${id}`;
      return { documentId: `doc-${id}`, note: 'Guardado en Mis notas privadas.' };
    },
    async remove(id) {
      await wait(200);
      rows.delete(id);
    },
    async spaces() {
      return [
        { id: 'sp1', name: 'Operaciones', kind: 'shared', writable: true },
        { id: 'sp2', name: 'Finanzas', kind: 'shared', writable: true },
        { id: 'sp3', name: 'Gerencia', kind: 'shared', writable: false },
      ];
    },
    async sources() {
      await wait(200);
      return { sources: SOURCES, impactTruncated: false };
    },
    async sourceAction() {
      await wait(400);
      return {};
    },
  };
}

const API_CLIENT: ApiWizardClient = {
  listApis: async () => ({ tools: [], canConfigure: true }),
  saveTool: async () => {
    throw new Error('En el escaparate no se guardan conexiones.');
  },
  deleteTool: async () => undefined,
  testTool: async () => {
    throw new Error('En el escaparate no se prueban conexiones.');
  },
  capture: async () => {
    throw new Error('En el escaparate no se consultan APIs.');
  },
  readTables: async () => ({ rows: null, text: '' }),
  updateSource: async () => undefined,
};

export function BandejaShowcase({
  dark,
  empty,
  open,
  view,
  mode,
}: {
  dark: boolean;
  empty: boolean;
  open: boolean;
  view: 'entries' | 'sources';
  mode: 'file' | 'url' | 'text' | 'api';
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const seeds = empty ? NO_SEEDS : SEEDS;
  const client = useMemo(() => memoryClient(seeds), [seeds]);
  const strip = ({ text: _t, tables: _x, ...e }: Seed): FeedEntry => e;
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-8">
        <Feed
          workspaceId="escaparate"
          initialEntries={seeds.map(strip)}
          initialMode={mode}
          initialView={view}
          initialOpenId={open ? 'e1' : undefined}
          tableSourceIds={['s-sheet']}
          client={client}
          apiClient={API_CLIENT}
          now={NOW}
        />
      </main>
    </div>
  );
}
