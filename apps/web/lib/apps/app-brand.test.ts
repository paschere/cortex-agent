import type { ViewBrand } from '@/lib/branding/shape';
import { describe, expect, it } from 'vitest';
import { colorReport, companyColorChoices, emailBrand, resolveAppBrand } from './app-brand';

const company: ViewBrand = {
  name: 'Transportes Andina',
  logoUrl: '/api/branding/logo?v=1',
  primary: '#1f6feb',
  secondary: '#f59e0b',
};
const url = (kind: string, v: string, t: string) => `/a/app/asset/${kind}?v=${v}.${t}`;
const app = { name: 'Control en planta' };

describe('marca app → empresa', () => {
  it('sin marca propia hereda todo de la empresa, como antes', () => {
    const r = resolveAppBrand(company, undefined, app, url);
    expect(r).toMatchObject({
      name: 'Transportes Andina',
      logoUrl: company.logoUrl,
      primary: '#1f6feb',
      secondary: '#f59e0b',
      shortName: 'Control en p',
      font: 'system',
      own: false,
      welcome: null,
    });
    expect(r.iconUrl).toBe(company.logoUrl);
  });

  it('cada campo se resuelve por su cuenta', () => {
    const r = resolveAppBrand(
      company,
      { primary: '#047857', shortName: 'Planta', font: 'serif' },
      app,
      url,
    );
    expect(r.primary).toBe('#047857');
    expect(r.secondary).toBe('#f59e0b');
    expect(r.logoUrl).toBe(company.logoUrl);
    expect(r.shortName).toBe('Planta');
    expect(r.font).toBe('serif');
    // Con color propio la cabecera lleva el nombre de la app.
    expect(r.own).toBe(true);
    expect(r.name).toBe('Control en planta');
  });

  it('logo propio gana; el ícono propio gana al logo', () => {
    const files = { logo: { v: 'aaaaaaaa', t: 'png' as const } };
    expect(resolveAppBrand(company, { files }, app, url).logoUrl).toBe(
      '/a/app/asset/logo?v=aaaaaaaa.png',
    );
    expect(resolveAppBrand(company, { files }, app, url).iconUrl).toBe(
      '/a/app/asset/logo?v=aaaaaaaa.png',
    );
    const both = { ...files, icon: { v: 'bbbbbbbb', t: 'png' as const } };
    expect(resolveAppBrand(company, { files: both }, app, url).iconUrl).toBe(
      '/a/app/asset/icon?v=bbbbbbbb.png',
    );
  });

  it('un color propio inválido se ignora y vale el de la empresa', () => {
    expect(resolveAppBrand(company, { primary: 'rojo' }, app, url).primary).toBe('#1f6feb');
  });

  it('la bienvenida existe si hay título, texto o imagen', () => {
    expect(resolveAppBrand(company, { welcome: { title: '  ' } }, app, url).welcome).toBeNull();
    const w = resolveAppBrand(
      company,
      {
        welcome: { title: 'Hola', text: 'Entra' },
        files: { welcome: { v: 'cccccccc', t: 'jpg' } },
      },
      app,
      url,
    ).welcome;
    expect(w).toEqual({
      title: 'Hola',
      text: 'Entra',
      imageUrl: '/a/app/asset/welcome?v=cccccccc.jpg',
    });
  });

  it('ofrece los colores de la empresa sin huecos', () => {
    expect(companyColorChoices(company)).toEqual(['#1f6feb', '#f59e0b']);
    expect(companyColorChoices({ primary: null, secondary: '#000000' })).toEqual(['#000000']);
  });
});

describe('contraste AA en claro y en oscuro', () => {
  it('un azul de marca pasa en todo y se dice que no hace falta ajustarlo en claro', () => {
    const r = colorReport('#1f6feb');
    expect(r.valid).toBe(true);
    expect(r.light).toBeGreaterThanOrEqual(4.5);
    expect(r.dark).toBeGreaterThanOrEqual(4.5);
    expect(r.button).toBeGreaterThanOrEqual(4.5);
    expect(r.passes).toBe(true);
  });

  it('un amarillo de taxi no pasa tal cual, pero se ajusta hasta pasar', () => {
    const r = colorReport('#ffd400');
    expect(r.passesRaw).toBe(false);
    expect(r.rawLight).toBeLessThan(4.5);
    expect(r.light).toBeGreaterThanOrEqual(4.5);
    expect(r.passes).toBe(true);
    expect(r.usedLight).not.toBe('#ffd400');
  });

  it('un azul casi negro no se lee en oscuro tal cual, y se aclara', () => {
    const r = colorReport('#0b1020');
    expect(r.rawDark).toBeLessThan(4.5);
    expect(r.dark).toBeGreaterThanOrEqual(4.5);
    expect(r.passes).toBe(true);
  });

  it('lo que no es color no vale', () => {
    expect(colorReport('azul').valid).toBe(false);
    expect(colorReport('').passes).toBe(false);
    expect(colorReport('#abc').valid).toBe(true);
  });

  it('todo el espectro pasa después del ajuste', () => {
    for (let h = 0; h < 360; h += 15) {
      const c = `#${[0, 8, 16]
        .map((o) =>
          Math.round(127 + 127 * Math.sin(((h + o * 15) * Math.PI) / 180))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
      expect(colorReport(c).passes, c).toBe(true);
    }
  });
});

describe('correos con la marca de la app', () => {
  it('sin identidad propia no cambia el encabezado de Cortex', () => {
    const view = resolveAppBrand(company, undefined, app, url);
    expect(emailBrand(view, 'https://x.co')).toBeUndefined();
  });
  it('con identidad propia lleva nombre, color legible, botón y logo absoluto', () => {
    const view = resolveAppBrand(
      company,
      { primary: '#ffd400', files: { icon: { v: 'dddddddd', t: 'png' } } },
      app,
      url,
    );
    const b = emailBrand(view, 'https://x.co');
    expect(b?.name).toBe('Control en planta');
    expect(b?.logoUrl).toBe('https://x.co/a/app/asset/icon?v=dddddddd.png');
    expect(b?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b?.buttonInk).toMatch(/^#[0-9a-f]{6}$/);
  });
});
