import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invoicesFromAttachment } from '../intake';
import { UblError, looksLikeUbl, parseUblInvoice, withholdingTotals } from '../ubl';
import { XmlError, parseXml } from '../xml';
import { isZip, readZip } from '../zip';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/** Un ZIP mínimo (deflate) para probar el lector sin binarios en el repo. */
function makeZip(files: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const comp = f.store ? f.data : deflateRawSync(f.data);
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cen = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, eocd]);
}

describe('xml', () => {
  it('lee elementos, atributos, CDATA y entidades sin prefijos', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><a:R xmlns:a="x"><a:B k="v &amp; w">1 &lt; 2</a:B><C><![CDATA[<no>]]></C><D/></a:R>',
    );
    expect(root.name).toBe('R');
    expect(root.children.map((c) => c.name)).toEqual(['B', 'C', 'D']);
    expect(root.children[0]?.attrs.k).toBe('v & w');
    expect(root.children[0]?.text).toBe('1 < 2');
    expect(root.children[1]?.text).toBe('<no>');
  });

  it('rechaza lo mal formado y no resuelve entidades externas', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    const root = parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>');
    expect(root.text).toBe('&e;');
  });
});

describe('parseUblInvoice', () => {
  it('lee una factura suelta de la DIAN', () => {
    const inv = parseUblInvoice(fixture('invoice-dian.xml'));
    expect(inv.kind).toBe('invoice');
    expect(inv.number).toBe('FEPA-00451');
    expect(inv.cufe).toMatch(/^8bb4b3c7/);
    expect(inv.issueDate).toBe('2026-09-28');
    expect(inv.dueDate).toBe('2026-10-28');
    expect(inv.currency).toBe('COP');
    expect(inv.supplier).toEqual({
      name: 'PAPELERIA EL CONDOR S.A.S.',
      nit: '900373115',
      dv: '2',
    });
    expect(inv.customer.nit).toBe('830025281');
    expect(inv.subtotal).toBe(2_000_000);
    expect(inv.iva).toBe(380_000);
    expect(inv.total).toBe(2_380_000);
    expect(withholdingTotals(inv)).toEqual({ retefuente: 50_000, reteiva: 0, reteica: 0 });
    expect(inv.orderReference).toBe('OC-2026-118');
    expect(inv.paymentMeansCode).toBe('2');
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({
      description: 'Resma papel carta 75 g',
      code: 'RES-75',
      quantity: 100,
      unitPrice: 15_000,
      amount: 1_500_000,
    });
    expect(inv.lines[1]?.description).toBe('Tóner HP 85A');
    expect(inv.dianValidation).toBeNull();
  });

  it('desenvuelve el AttachedDocument y lee la validación de la DIAN', () => {
    const xml = fixture('attached-document.xml');
    expect(looksLikeUbl(xml)).toBe(true);
    const inv = parseUblInvoice(xml);
    expect(inv.number).toBe('FEPA-00451');
    expect(inv.total).toBe(2_380_000);
    expect(inv.dianValidation).toEqual({
      accepted: true,
      description: 'Documento validado por la DIAN',
    });
  });

  it('reconoce una nota crédito con prefijos raros y NIT con guion', () => {
    const inv = parseUblInvoice(fixture('credit-note.xml'));
    expect(inv.kind).toBe('credit_note');
    expect(inv.number).toBe('NC-77');
    expect(inv.supplier.nit).toBe('900373115');
    expect(inv.supplier.dv).toBe('2');
    expect(inv.billingReference).toBe('FEPA-00451');
    expect(inv.lines[0]?.quantity).toBe(10);
  });

  it('dice qué falta', () => {
    expect(() => parseUblInvoice('<Invoice><ID>1</ID></Invoice>')).toThrow(UblError);
    expect(() => parseUblInvoice('<ApplicationResponse/>')).toThrow(/no una factura/);
    expect(() => parseUblInvoice('no es xml <')).toThrow(UblError);
  });
});

describe('zip', () => {
  it('lee entradas guardadas y comprimidas', () => {
    const zip = makeZip([
      { name: 'ad0900373115.xml', data: Buffer.from(fixture('attached-document.xml')) },
      { name: 'fv.pdf', data: Buffer.from('%PDF-1.4 hola'), store: true },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['ad0900373115.xml', 'fv.pdf']);
    expect(entries[1]?.data.toString()).toBe('%PDF-1.4 hola');
    expect(readZip(zip, (n) => n.endsWith('.xml'))).toHaveLength(1);
  });

  it('el paquete de la DIAN sale como una factura con su PDF', () => {
    const zip = makeZip([
      { name: 'z/ad0900373115.xml', data: Buffer.from(fixture('attached-document.xml')) },
      { name: 'z/fv0900373115.pdf', data: Buffer.from('%PDF') },
    ]);
    const found = invoicesFromAttachment('factura.zip', zip);
    expect(found.invoices).toHaveLength(1);
    expect(found.invoices[0]?.invoice.number).toBe('FEPA-00451');
    expect(found.invoices[0]?.files).toEqual(['ad0900373115.xml', 'fv0900373115.pdf']);
    expect(found.notes).toEqual([]);
  });

  it('un XML suelto y un ZIP sin factura', () => {
    expect(
      invoicesFromAttachment('fe.xml', Buffer.from(fixture('invoice-dian.xml'))).invoices,
    ).toHaveLength(1);
    const empty = invoicesFromAttachment(
      'fotos.zip',
      makeZip([{ name: 'a.txt', data: Buffer.from(['h', 'o', 'l', 'a'].join('')) }]),
    );
    expect(empty.invoices).toEqual([]);
    expect(invoicesFromAttachment('x.zip', Buffer.from('no zip')).errors.length).toBe(1);
  });
});
