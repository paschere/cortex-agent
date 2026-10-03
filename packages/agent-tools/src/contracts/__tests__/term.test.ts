import { describe, expect, it } from 'vitest';
import { collectContractNotices } from '../autopilot';
import {
  clauseHead,
  contractDocumentXml,
  crc32,
  renderContractDocx,
  renderContractPdf,
} from '../document';
import {
  type ContractRow,
  canSeeContract,
  contractTerm,
  deriveContractStatus,
  monthsBetween,
} from '../shape';

const base: Pick<
  ContractRow,
  'start_on' | 'end_on' | 'renewal' | 'renewal_months' | 'notice_days' | 'status'
> = {
  start_on: '2025-01-01',
  end_on: '2025-12-31',
  renewal: 'automatica',
  renewal_months: null,
  notice_days: 30,
  status: 'firmado',
};

describe('la vigencia de un contrato', () => {
  it('cuenta meses enteros', () => {
    expect(monthsBetween('2025-01-01', '2026-01-01')).toBe(12);
    expect(monthsBetween('2025-03-15', '2025-09-15')).toBe(6);
  });

  it('uno que se renueva solo corre su fin hasta pasar hoy', () => {
    const t = contractTerm(base, '2026-10-03');
    // 2025-12-31 + 12 meses = 2026-12-31.
    expect(t.currentEnd).toBe('2026-12-31');
    expect(t.renewals).toBe(1);
    expect(t.noticeDeadline).toBe('2026-12-01');
    expect(t.daysToNotice).toBe(59);
    expect(deriveContractStatus(base, '2026-10-03')).toBe('vigente');
  });

  it('con prórroga pactada no se corre: vence', () => {
    const row = { ...base, renewal: 'prorroga' as const };
    expect(contractTerm(row, '2026-10-03').currentEnd).toBe('2025-12-31');
    expect(deriveContractStatus(row, '2026-10-03')).toBe('vencido');
  });

  it('firmado y todavía no empieza; borrador y terminado son decisiones', () => {
    expect(
      deriveContractStatus({ ...base, start_on: '2027-01-01', end_on: '2027-12-31' }, '2026-10-03'),
    ).toBe('firmado');
    expect(deriveContractStatus({ ...base, status: 'borrador' }, '2030-01-01')).toBe('borrador');
    expect(deriveContractStatus({ ...base, status: 'terminado' }, '2026-01-01')).toBe('terminado');
  });

  it('meses de renovación explícitos mandan', () => {
    const t = contractTerm({ ...base, renewal_months: 6 }, '2026-10-03');
    expect(t.currentEnd).toBe('2026-12-31');
    expect(t.renewals).toBe(2);
  });
});

describe('quién ve un contrato', () => {
  const labor = {
    contract_type: 'laboral_fijo' as const,
    counterparty_kind: 'empleado' as const,
    created_by: 'a',
    owner_user_id: 'b',
  };
  it('uno laboral sólo quien administra, quien lo creó o su responsable', () => {
    expect(canSeeContract(labor, { userId: 'x', manager: false })).toBe(false);
    expect(canSeeContract(labor, { userId: 'x', manager: true })).toBe(true);
    expect(canSeeContract(labor, { userId: 'a', manager: false })).toBe(true);
    expect(canSeeContract(labor, { userId: 'b', manager: false })).toBe(true);
    expect(
      canSeeContract(
        { ...labor, contract_type: 'compraventa', counterparty_kind: 'cliente' },
        { userId: 'x', manager: false },
      ),
    ).toBe(true);
  });
});

describe('el contrato como archivo', () => {
  const text =
    'BORRADOR PARA REVISIÓN DE UN ABOGADO. Generado con Cortex a partir de una plantilla: no es asesoría legal ni garantiza la validez de lo que dice. Complete los campos marcados [COMPLETAR], revise cada cláusula y ajústela a su caso antes de firmar.\n\nCONTRATO DE COMPRAVENTA\n\nPRIMERA. OBJETO. EL VENDEDOR transfiere los bienes & <cosas>.\n\nSEGUNDA. PRECIO. Doce millones.';

  it('separa la cabecera de la cláusula', () => {
    expect(clauseHead('PRIMERA. OBJETO. EL VENDEDOR transfiere')).toEqual({
      head: 'PRIMERA. OBJETO.',
      rest: 'EL VENDEDOR transfiere',
    });
    expect(clauseHead('DÉCIMA PRIMERA. SOLUCIÓN DE CONTROVERSIAS. Las diferencias')?.head).toBe(
      'DÉCIMA PRIMERA. SOLUCIÓN DE CONTROVERSIAS.',
    );
    expect(clauseHead('Entre las partes se acuerda')).toBeNull();
  });

  it('el PDF es un PDF y lleva la franja de borrador', () => {
    const bytes = renderContractPdf({
      title: 'Compraventa — Coltrans',
      text,
      brand: { name: 'Transportes Andinos', primary: '#0f766e' },
      generatedOn: '2026-10-03',
    });
    const head = Buffer.from(bytes.slice(0, 8)).toString('latin1');
    expect(head.startsWith('%PDF-1.4')).toBe(true);
    const all = Buffer.from(bytes).toString('latin1');
    expect(all).toContain('BORRADOR PARA REVISI');
    expect(all).toContain('%%EOF');
  });

  it('el Word es un ZIP con el documento y el aviso arriba, y escapa el XML', () => {
    const xml = contractDocumentXml({ title: 'X', text, companyName: 'Andinos' });
    expect(xml.indexOf('BORRADOR PARA REVISIÓN DE UN ABOGADO')).toBeLessThan(
      xml.indexOf('CONTRATO DE COMPRAVENTA'),
    );
    expect(xml).toContain('&amp; &lt;cosas&gt;');
    const zip = renderContractDocx({ title: 'X', text, companyName: 'Andinos' });
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const s = Buffer.from(zip).toString('latin1');
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
    ]) {
      expect(s).toContain(part);
    }
    // Sin compresión: el XML viaja tal cual (y se puede descomprimir como «stored»).
    expect(s).toContain('CONTRATO DE COMPRAVENTA');
  });

  it('crc32 da el valor conocido', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('el piloto y los avisos previos', () => {
  it('cuenta la ventana y deja los dos últimos días al recordatorio del compromiso', () => {
    const items = collectContractNotices(
      [
        {
          id: 'a',
          title: 'Arriendo bodega',
          counterparty: 'Inmobiliaria Sur',
          renewal: 'automatica',
          noticeDeadline: '2026-10-10',
          currentEnd: '2027-04-10',
          hasNoticeCommitment: true,
        },
        {
          id: 'b',
          title: 'NDA Coltrans',
          counterparty: null,
          renewal: 'automatica',
          noticeDeadline: '2026-10-04',
          currentEnd: '2026-11-04',
          hasNoticeCommitment: true,
        },
        {
          id: 'c',
          title: 'Servicio de aseo',
          counterparty: 'Limpio Ltda',
          renewal: 'ninguna',
          noticeDeadline: null,
          currentEnd: '2026-10-12',
          hasNoticeCommitment: false,
        },
      ],
      '2026-10-03',
    );
    expect(items.map((i) => i.dedupeKey)).toEqual([
      'contrato:aviso:a:2026-10-10',
      'contrato:fin:c:2026-10-12',
    ]);
    expect(items.every((i) => i.proposedAction === null)).toBe(true);
    expect(items[0]?.title).toMatch(/quedan 7 días/);
  });
});
