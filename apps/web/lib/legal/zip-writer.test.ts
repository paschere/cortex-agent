import { readZip } from '@cortex/agent-tools/src/payables/zip';
import { describe, expect, it } from 'vitest';
import { ZipStreamWriter, crc32, partitionedSink } from './zip-writer';

async function build(entries: Array<[string, Buffer | Buffer[], boolean?]>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const zip = new ZipStreamWriter(async (c) => {
    chunks.push(Buffer.from(c));
  });
  for (const [name, data, compress] of entries) {
    const source = Array.isArray(data)
      ? (async function* () {
          for (const d of data) yield d;
        })()
      : data;
    await zip.addEntry(name, source, { compress: compress ?? true });
  }
  await zip.finish();
  return Buffer.concat(chunks);
}

describe('ZIP en flujo, sin dependencias', () => {
  it('CRC-32 conocido', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('lo que escribe lo lee el lector de payables/zip.ts (deflate y guardado)', async () => {
    const big = Buffer.from('fila,'.repeat(50_000));
    const zip = await build([
      ['LEEME.txt', Buffer.from('hola, mundo', 'utf8')],
      ['tablas/clients.json', [Buffer.from('[\n'), Buffer.from('{"a":1}'), Buffer.from('\n]\n')]],
      ['archivos/audio.webm', Buffer.from([0, 1, 2, 3, 250, 251]), false],
      ['tablas/grande.json', [big.subarray(0, 100_000), big.subarray(100_000)]],
      ['tablas/vacía.json', Buffer.alloc(0)],
    ]);
    const entries = readZip(zip);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect(byName.get('LEEME.txt')?.toString('utf8')).toBe('hola, mundo');
    expect(byName.get('tablas/clients.json')?.toString('utf8')).toBe('[\n{"a":1}\n]\n');
    expect([...(byName.get('archivos/audio.webm') ?? [])]).toEqual([0, 1, 2, 3, 250, 251]);
    expect(byName.get('tablas/grande.json')?.equals(big)).toBe(true);
    // Comprime de verdad lo repetitivo.
    expect(zip.length).toBeLessThan(big.length / 10);
  });

  it('las partes de 16 MB (aquí de 7 bytes) concatenadas son el ZIP entero', async () => {
    const parts: Buffer[] = [];
    const { sink, flush } = partitionedSink(7, async (index, content) => {
      expect(index).toBe(parts.length);
      parts.push(Buffer.from(content));
    });
    const zip = new ZipStreamWriter(sink);
    await zip.addEntry('a.txt', Buffer.from('abcdefghijklmnopqrstuvwxyz', 'utf8'));
    const { bytes } = await zip.finish();
    const count = await flush();
    expect(count).toBe(parts.length);
    expect(parts.slice(0, -1).every((p) => p.length === 7)).toBe(true);
    const whole = Buffer.concat(parts);
    expect(whole.length).toBe(bytes);
    expect(readZip(whole)[0]?.data.toString()).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('no deja escribir después de cerrar', async () => {
    const zip = new ZipStreamWriter(async () => undefined);
    await zip.finish();
    await expect(zip.addEntry('x', Buffer.from('y', 'utf8'))).rejects.toThrow();
  });
});
