'use client';

import { OutboxBar } from '@/components/apps/AppCaptureLayer';
import { FileInput } from '@/components/views/inputs/FileInput';
import { ScanInput } from '@/components/views/inputs/ScanInput';
import { SignatureInput } from '@/components/views/inputs/SignatureInput';
import { CaptureContext } from '@/components/views/inputs/capture-context';
import type { OutboxItem } from '@/lib/apps/op-queue';
import { summarizeOutbox } from '@/lib/apps/op-queue';
import { useState } from 'react';

/**
 * La captura de campo con datos inventados (`/v/apps-showcase?vista=captura`):
 * la barra de pendientes sin señal (con un rechazo y un conflicto abiertos),
 * el lector de códigos (uno y continuo), la firma y la foto con evidencia.
 * `?sin=1` deja la barra con señal y enviando; `?cerrada=1` la deja plegada.
 */

const NOW = Date.now();

const ITEMS: OutboxItem[] = [
  {
    id: '1',
    kind: 'form',
    label: 'Registro nuevo · Guía 123-45678901 · Bogotá',
    state: 'pending',
    attempts: 0,
    createdAt: NOW - 120_000,
  },
  {
    id: '2',
    kind: 'edit',
    label: 'Estado: En bodega → Despachado',
    state: 'retrying',
    attempts: 2,
    createdAt: NOW - 90_000,
  },
  {
    id: '3',
    kind: 'act',
    label: 'Aprobar: Guía 123-45678902',
    state: 'rejected',
    attempts: 1,
    createdAt: NOW - 60_000,
    error: 'Tu rol en esta aplicación no usa este botón.',
  },
  {
    id: '4',
    kind: 'edit',
    label: 'Estado: Recibido → Entregado',
    state: 'conflict',
    attempts: 1,
    createdAt: NOW - 30_000,
    conflict: [{ field: 'Estado', was: 'Recibido', mine: 'Entregado', theirs: 'Anulado' }],
  },
];

export function CaptureFixture({ online, closed }: { online: boolean; closed: boolean }) {
  const [codes, setCodes] = useState('7701234567890\nAB-1234');
  const [single, setSingle] = useState('');
  const [sign, setSign] = useState('');
  const [photo, setPhoto] = useState('');
  const items = online ? ITEMS.slice(0, 2) : ITEMS;
  return (
    <CaptureContext.Provider value={{ userName: 'Ana Gómez', appName: 'Control en planta' }}>
      <div className="mx-auto max-w-xl space-y-6 px-4 py-4">
        <OutboxBar
          snap={{
            online,
            syncing: online,
            items,
            summary: summarizeOutbox(items, online, online),
          }}
          note={online ? null : 'Estás viendo lo guardado hace 12 minutos.'}
          defaultOpen={!closed}
          onRetry={() => undefined}
          onDiscard={() => undefined}
          onResolve={() => undefined}
        />
        <section className="space-y-2 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">Guías de la caja (escanear varios)</h2>
          <ScanInput value={codes} onChange={setCodes} continuous multiline large />
        </section>
        <section className="space-y-2 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">Código del lote</h2>
          <ScanInput value={single} onChange={setSingle} />
        </section>
        <section className="space-y-2 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">Firma de quien recibe</h2>
          <SignatureInput
            value={sign}
            onChange={setSign}
            target={{ kind: 'demo' }}
            blockId="demo"
            field="firma"
          />
        </section>
        <section className="space-y-2 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">Foto de la entrega (con evidencia)</h2>
          <FileInput
            value={photo}
            onChange={setPhoto}
            accept="image"
            target={{ kind: 'demo' }}
            blockId="demo"
            field="foto"
            evidence
            watermark
          />
        </section>
      </div>
    </CaptureContext.Provider>
  );
}
