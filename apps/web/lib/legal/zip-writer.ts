import { createDeflateRaw } from 'node:zlib';

/**
 * ESCRIBIR UN ZIP SIN TENERLO ENTERO EN MEMORIA, Y SIN DEPENDENCIAS.
 *
 * La exportación de una empresa puede pesar cientos de megas (audio de
 * reuniones, documentos). Armarla en memoria sería tumbar el trabajo justo con
 * los clientes que más datos tienen. Este escritor emite el ZIP en orden, como
 * un flujo: cabecera local, datos (comprimidos con deflate mientras pasan) y un
 * «descriptor de datos» con el CRC y los tamaños al final de cada entrada (bit 3
 * de los flags), porque al empezar una entrada todavía no se conocen. El
 * directorio central se guarda en memoria (unos 100 bytes por entrada) y se
 * escribe al cerrar.
 *
 * Lo que NO hace: ZIP64. Ninguna entrada ni el total pueden pasar de 4 GB, ni
 * haber más de 65 535 entradas; si pasa, lanza en vez de escribir un ZIP roto.
 * El lector de payables/zip.ts (sin dependencias, como éste) lo lee en las
 * pruebas.
 */

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** Bit 3 (descriptor de datos) + bit 11 (nombres en UTF-8). */
const FLAGS = 0x0808;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, buf: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32(buf: Uint8Array): number {
  return crc32Update(0, buf);
}

/** Fecha y hora DOS: lo que el formato pide. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface CentralEntry {
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export type ZipSink = (chunk: Buffer) => Promise<void>;

export class ZipLimitError extends Error {}

export class ZipStreamWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private closed = false;
  private readonly when: { time: number; date: number };

  constructor(
    private readonly sink: ZipSink,
    now: Date = new Date(),
  ) {
    this.when = dosDateTime(now);
  }

  /** Bytes escritos hasta ahora. */
  get bytesWritten(): number {
    return this.offset;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  private async write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    if (this.offset > MAX_U32) throw new ZipLimitError('El ZIP pasó de 4 GB (sin ZIP64).');
    await this.sink(chunk);
  }

  /**
   * Añade una entrada. `source` puede ser un Buffer o un iterable asíncrono de
   * trozos (para tablas que se leen por páginas). `compress=false` guarda tal
   * cual — útil para lo que ya viene comprimido (audio, PDF, imágenes).
   */
  async addEntry(
    name: string,
    source: Buffer | AsyncIterable<Buffer>,
    options: { compress?: boolean } = {},
  ): Promise<void> {
    if (this.closed) throw new Error('El ZIP ya se cerró.');
    if (this.entries.length >= MAX_ENTRIES) {
      throw new ZipLimitError('Demasiadas entradas para un ZIP sin ZIP64.');
    }
    const compress = options.compress ?? true;
    const nameBuf = Buffer.from(name.replace(/^\/+/, ''), 'utf8');
    const method = compress ? 8 : 0;
    const start = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4); // versión necesaria
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.when.time, 10);
    header.writeUInt16LE(this.when.date, 12);
    // crc y tamaños en cero: van en el descriptor (bit 3).
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(header);
    await this.write(nameBuf);

    let crc = 0;
    let size = 0;
    let compressed = 0;

    const chunks: AsyncIterable<Buffer> = Buffer.isBuffer(source)
      ? (async function* () {
          yield source;
        })()
      : source;

    if (!compress) {
      for await (const chunk of chunks) {
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        compressed += chunk.length;
        await this.write(chunk);
      }
    } else {
      const deflate = createDeflateRaw({ level: 6 });
      const pending: Buffer[] = [];
      let ended = false;
      let failure: Error | null = null;
      let wake: (() => void) | null = null;
      deflate.on('data', (c: Buffer) => {
        pending.push(c);
        wake?.();
      });
      deflate.on('end', () => {
        ended = true;
        wake?.();
      });
      deflate.on('error', (e: Error) => {
        failure = e;
        wake?.();
      });
      const drain = async () => {
        while (pending.length > 0) {
          const c = pending.shift() as Buffer;
          compressed += c.length;
          await this.write(c);
        }
      };
      for await (const chunk of chunks) {
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        if (!deflate.write(chunk)) {
          await new Promise<void>((resolve) => deflate.once('drain', () => resolve()));
        }
        await drain();
      }
      deflate.end();
      while (!ended) {
        if (failure) throw failure;
        if (pending.length === 0 && !ended && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        await drain();
      }
      await drain();
      if (failure) throw failure;
    }

    if (size > MAX_U32 || compressed > MAX_U32) {
      throw new ZipLimitError(`La entrada ${name} pasó de 4 GB (sin ZIP64).`);
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR_SIG, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);

    this.entries.push({
      name: nameBuf,
      method,
      crc,
      compressed,
      size,
      offset: start,
      time: this.when.time,
      date: this.when.date,
    });
  }

  /** Escribe el directorio central. Después de esto el ZIP está completo. */
  async finish(): Promise<{ bytes: number; entries: number }> {
    if (this.closed) throw new Error('El ZIP ya se cerró.');
    this.closed = true;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(CENTRAL_SIG, 0);
      rec.writeUInt16LE(20, 4); // hecho por
      rec.writeUInt16LE(20, 6); // necesaria
      rec.writeUInt16LE(FLAGS, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(e.time, 12);
      rec.writeUInt16LE(e.date, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressed, 20);
      rec.writeUInt32LE(e.size, 24);
      rec.writeUInt16LE(e.name.length, 28);
      rec.writeUInt32LE(e.offset, 42);
      await this.write(rec);
      await this.write(e.name);
    }
    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIG, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    return { bytes: this.offset, entries: this.entries.length };
  }
}

/**
 * Un sumidero que junta trozos hasta `partBytes` y los entrega como partes
 * numeradas. Así el ZIP se guarda en app_files como varias filas
 * (`…/export.zip.part-0000`, `…part-0001`) sin reescribir nunca un bytea
 * creciente — el `content || chunk` de appendFileDirect reescribe el valor
 * entero en cada llamada, y con cientos de megas eso es cuadrático.
 */
export function partitionedSink(
  partBytes: number,
  savePart: (index: number, content: Buffer) => Promise<void>,
): { sink: ZipSink; flush: () => Promise<number> } {
  let buffer: Buffer[] = [];
  let buffered = 0;
  let index = 0;
  const emit = async () => {
    if (buffered === 0) return;
    const content = Buffer.concat(buffer, buffered);
    buffer = [];
    buffered = 0;
    await savePart(index, content);
    index++;
  };
  return {
    sink: async (chunk) => {
      buffer.push(chunk);
      buffered += chunk.length;
      while (buffered >= partBytes) {
        const all = Buffer.concat(buffer, buffered);
        buffer = [all.subarray(partBytes)];
        buffered = all.length - partBytes;
        await savePart(index, all.subarray(0, partBytes));
        index++;
      }
    },
    flush: async () => {
      await emit();
      return index;
    },
  };
}
