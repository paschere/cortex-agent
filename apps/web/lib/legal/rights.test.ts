import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { legalEntity } from './config';
import { legalDocumentBySlug } from './documents';
import { classifyMemberships } from './memberships';
import { canDeleteCompany, canExportCompany, confirmsCompanyName } from './permissions';
import { kindForRight } from './rights';

describe('quién puede qué', () => {
  it('exportar la empresa: dueño o administrador; borrarla: sólo el dueño', () => {
    expect(canExportCompany('owner')).toBe(true);
    expect(canExportCompany('admin')).toBe(true);
    expect(canExportCompany('member')).toBe(false);
    expect(canDeleteCompany('owner')).toBe(true);
    expect(canDeleteCompany('admin')).toBe(false);
  });

  it('la segunda confirmación exige el nombre exacto (sin importar mayúsculas ni espacios)', () => {
    expect(confirmsCompanyName('  transportes   del valle ', 'Transportes del Valle')).toBe(true);
    expect(confirmsCompanyName('Transportes', 'Transportes del Valle')).toBe(false);
    expect(confirmsCompanyName('', '')).toBe(false);
  });

  it('consulta o reclamo según el derecho que se ejerce', () => {
    expect(kindForRight('conocer')).toBe('consulta');
    expect(kindForRight('prueba')).toBe('consulta');
    expect(kindForRight('suprimir')).toBe('reclamo');
    expect(kindForRight('rectificar')).toBe('reclamo');
    expect(kindForRight('revocar')).toBe('reclamo');
  });
});

describe('borrar mi usuario', () => {
  const m = (name: string, role: string, members: number, owners: number) => ({
    organizationId: name,
    organizationName: name,
    role,
    members,
    owners,
  });

  it('la única dueña de una empresa con más gente no puede irse sin dejar dueña', () => {
    const r = classifyMemberships([m('Empresa', 'owner', 3, 1)]);
    expect(r.blockers.map((b) => b.organizationName)).toEqual(['Empresa']);
  });

  it('su espacio personal (sólo ella) se purga con la cuenta; de los demás sale', () => {
    const r = classifyMemberships([
      m('Personal', 'owner', 1, 1),
      m('Socios', 'owner', 4, 2),
      m('Cliente', 'member', 9, 1),
    ]);
    expect(r.blockers).toEqual([]);
    expect(r.solo.map((x) => x.organizationName)).toEqual(['Personal']);
    expect(r.shared.map((x) => x.organizationName)).toEqual(['Socios', 'Cliente']);
  });
});

describe('textos legales: sin datos inventados', () => {
  it('sin LEGAL_* se ven los marcadores y la franja de borrador', () => {
    const e = legalEntity({});
    expect(e.draft).toBe(true);
    expect(e.razonSocial).toBe('[RAZÓN SOCIAL]');
    expect(e.missing).toEqual(
      expect.arrayContaining([
        '[RAZÓN SOCIAL]',
        '[NIT]',
        '[DIRECCIÓN]',
        '[CORREO DE CONTACTO]',
        '[FECHA DE VIGENCIA]',
      ]),
    );
    const text = JSON.stringify(legalDocumentBySlug('tratamiento-de-datos', e));
    expect(text).toContain('[NIT]');
    expect(text).toContain('[CORREO DE CONTACTO]');
  });

  it('con LEGAL_* puestos los usa, y LEGAL_DRAFT=false apaga la franja', () => {
    const e = legalEntity({
      LEGAL_RAZON_SOCIAL: 'Cortex S.A.S.',
      LEGAL_NIT: '900.000.000-1',
      LEGAL_DRAFT: 'false',
    });
    expect(e.draft).toBe(false);
    expect(JSON.stringify(legalDocumentBySlug('terminos', e))).toContain('Cortex S.A.S.');
  });

  it('la política de tratamiento trae lo que exige el Decreto 1377 art. 13', () => {
    const doc = legalDocumentBySlug('tratamiento-de-datos', legalEntity({}));
    const ids = doc.sections.map((s) => s.id);
    for (const id of [
      'responsable',
      'finalidades',
      'derechos',
      'procedimiento',
      'transferencias',
      'seguridad',
      'vigencia',
    ]) {
      expect(ids, id).toContain(id);
    }
    const text = JSON.stringify(doc);
    expect(text).toMatch(/diez \(10\) días hábiles/);
    expect(text).toMatch(/quince \(15\) días hábiles/);
    for (const right of [
      'Conocer, actualizar y rectificar',
      'Revocar la autorización',
      'prueba de la autorización',
    ]) {
      expect(text).toContain(right);
    }
  });
});

describe('las páginas legales abren sin sesión', () => {
  it('están en PUBLIC_PATHS, y /api/legal no', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
      'utf8',
    );
    const block = src.slice(
      src.indexOf('const PUBLIC_PATHS'),
      src.indexOf('interface SessionPayload'),
    );
    for (const path of ['/privacidad', '/terminos', '/cookies', '/tratamiento-de-datos']) {
      expect(block).toContain(`'${path}'`);
    }
    expect(block).not.toContain("'/api/legal'");
  });
});
