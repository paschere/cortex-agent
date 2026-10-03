import { inflateRawSync } from 'node:zlib';

/**
 * LEER UN ZIP SIN DEPENDENCIAS (el paquete de la factura electrónica).
 *
 * La DIAN exige que la factura viaje como un ZIP con el XML (AttachedDocument)
 * y el PDF. Este lector entiende lo que esos ZIP usan: directorio central,
 * entradas guardadas (método 0) o comprimidas con deflate (método 8). No
 * entiende ZIP64, cifrado ni ZIP partidos: esas entradas se saltan.
 *
 * Defensivo con lo que llega de afuera: tope de entradas, tope de tamaño por
 * entrada y en total (un «zip bomb» no llena la memoria del trabajo), y los
 * nombres con rutas raras sólo se usan como texto, nunca para escribir disco.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 50;
const MAX_ENTRY_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG;
}

function findEocd(buf: Buffer): number {
  // El fin del directorio central está en los últimos 22 + 65 535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Las entradas del ZIP cuyo nombre pasa `want` (por defecto, todas). Lanza
 * `ZipError` si el archivo no es un ZIP legible.
 */
export function readZip(buf: Buffer, want: (name: string) => boolean = () => true): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('No es un ZIP (no tiene directorio central).');
  const count = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (cenOffset >= buf.length) throw new ZipError('El ZIP está cortado.');
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cenOffset;
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG)
      throw new ZipError('El directorio del ZIP está dañado.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const utf8 = (flags & 0x0800) !== 0;
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(utf8 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    const encrypted = (flags & 0x0001) !== 0;
    const isDir = name.endsWith('/');
    if (isDir || encrypted || !want(name)) continue;
    if (size > MAX_ENTRY_BYTES || compSize > MAX_ENTRY_BYTES) continue;
    if (total + size > MAX_TOTAL_BYTES) break;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        continue;
      }
    } else continue;
    total += data.length;
    out.push({ name, data });
  }
  return out;
}

/** El nombre sin carpetas, en minúsculas: «Factura/FE-12.XML» → «fe-12.xml». */
export function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).toLowerCase();
}
