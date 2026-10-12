import { describe, expect, it } from 'vitest';
import {
  collectFiles,
  driveUploadPrompt,
  extensionOf,
  fileKindOf,
  filesFromText,
  fromDocument,
  fromPresentation,
  fromReport,
  humanSize,
  windowFor,
} from './files';

const NOW = new Date('2026-10-11T12:00:00Z');

describe('tipo de archivo', () => {
  it('por extensión primero, por mime si no hay', () => {
    expect(fileKindOf('Informe.PDF')).toBe('pdf');
    expect(fileKindOf('ventas.xlsx')).toBe('sheet');
    expect(fileKindOf('cartera.csv')).toBe('csv');
    expect(fileKindOf('deck.pptx')).toBe('slides');
    expect(fileKindOf('sin-extension', 'application/pdf')).toBe('pdf');
    expect(fileKindOf('x', 'application/vnd.ms-excel')).toBe('sheet');
    expect(fileKindOf('x', null)).toBe('other');
    expect(extensionOf('a/b/c.tar.gz?x=1')).toBe('gz');
  });

  it('tamaños legibles', () => {
    expect(humanSize(null)).toBe('—');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(84 * 1024)).toBe('84 KB');
    expect(humanSize(1.2 * 1024 * 1024)).toBe('1,2 MB');
  });
});

describe('ventana de tiempo', () => {
  it('añade holgura a los dos lados y usa ahora si sigue abierta', () => {
    const w = windowFor({ from: '2026-10-11T10:00:00Z', to: '2026-10-11T10:30:00Z', now: NOW });
    expect(w?.from).toBe('2026-10-11T09:59:55.000Z');
    expect(w?.to).toBe('2026-10-11T10:32:00.000Z');
    const open = windowFor({ from: '2026-10-11T10:00:00Z', to: null, now: NOW });
    expect(open?.to).toBe('2026-10-11T12:02:00.000Z');
    expect(windowFor({ from: null, to: null, now: NOW })).toBeNull();
  });
});

describe('normalizadores', () => {
  it('una presentación vencida no se lista', () => {
    const row = {
      token: 't1',
      filename: 'Candidato.pdf',
      size_bytes: 90_000,
      created_at: '2026-10-11T10:00:00Z',
      expires_at: '2026-10-18T10:00:00Z',
    };
    expect(fromPresentation(row, NOW)?.href).toBe('/api/files/presentation/t1');
    expect(fromPresentation({ ...row, expires_at: '2026-10-10T00:00:00Z' }, NOW)).toBeNull();
  });

  it('un informe abre su pantalla', () => {
    const f = fromReport({ id: 'r1', title: 'Vencimientos', generated_at: '2026-10-11T10:00:00Z' });
    expect(f.href).toBe('/reports/r1');
    expect(f.driveable).toBe(false);
  });

  it('un documento sin enlace firmado no se lista; con enlace de /api/files/blob se puede subir a Drive', () => {
    const base = {
      id: 'd1',
      title: 'Paz y salvo.pdf',
      mime: 'application/pdf',
      created_at: '2026-10-11T10:00:00Z',
      sizeBytes: 1000,
    };
    expect(fromDocument({ ...base, downloadHref: null })).toBeNull();
    const f = fromDocument({ ...base, downloadHref: '/api/files/blob/abc.def' });
    expect(f?.driveable).toBe(true);
    expect(f?.kind).toBe('pdf');
  });
});

describe('enlaces dentro de la respuesta', () => {
  const at = '2026-10-11T10:00:00Z';

  it('toma enlaces de descarga y deja los demás', () => {
    const text = [
      'Aquí está [Cartera.xlsx](https://files.example.com/cartera.xlsx) y [la guía](https://example.com/guia).',
      'También [Export](/api/files/blob/abc.def) y [Informe](/api/files/report/tok1234567890123456789012345678901234).',
      'Y [el sitio](https://example.com/) no es un archivo.',
    ].join('\n');
    const files = filesFromText(text, at);
    expect(files.map((f) => f.href)).toEqual([
      'https://files.example.com/cartera.xlsx',
      '/api/files/blob/abc.def',
    ]);
    expect(files[0]?.external).toBe(true);
    expect(files[0]?.kind).toBe('sheet');
    expect(files[1]?.external).toBe(false);
  });

  it('reconoce los enlaces absolutos de este sitio como internos', () => {
    const files = filesFromText('[Datos](https://app.cortex.test/api/files/blob/x.y)', at, {
      origin: 'https://app.cortex.test',
    });
    expect(files[0]?.href).toBe('/api/files/blob/x.y');
    expect(files[0]?.external).toBe(false);
  });

  it('cada enlace una sola vez', () => {
    const files = filesFromText('[A](https://x.com/a.pdf) [B](https://x.com/a.pdf)', at);
    expect(files).toHaveLength(1);
  });
});

describe('juntar', () => {
  it('quita repetidos por id y por enlace, y deja lo más reciente primero', () => {
    const a = fromReport({ id: 'r1', title: 'A', generated_at: '2026-10-11T10:00:00Z' });
    const b = fromReport({ id: 'r2', title: 'B', generated_at: '2026-10-11T11:00:00Z' });
    const link = filesFromText('[X](https://x.com/x.pdf)', '2026-10-11T09:00:00Z');
    const dupe = filesFromText('[X otra vez](https://x.com/x.pdf)', '2026-10-11T09:30:00Z');
    const all = collectFiles([a, null, b], link, dupe, [a]);
    expect(all.map((f) => f.name)).toEqual(['B', 'A', 'X']);
  });

  it('el mensaje para subir a Drive lleva el archivo tal como lo lee gdrive.upload_file', () => {
    const prompt = driveUploadPrompt({
      name: 'Paz y salvo.pdf',
      href: '/api/files/blob/abc.def',
      mime: 'application/pdf',
      sizeBytes: 1000,
    });
    expect(prompt).toContain('gdrive.upload_file');
    expect(prompt).toContain('"url":"/api/files/blob/abc.def"');
    expect(prompt).toContain('"name":"Paz y salvo.pdf"');
  });
});
