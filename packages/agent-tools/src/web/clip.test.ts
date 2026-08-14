import { describe, expect, it } from 'vitest';
import { clip } from './scrape';

/**
 * EL CASO REAL, CON SUS NÚMEROS.
 *
 * `www.bbicolombia.com` devuelve 21.693 caracteres; su NIT está en el 20.916.
 * Con el corte por el principio en 20.000 —el máximo que permite el esquema— el
 * NIT se perdía por 916 caracteres, y la pantalla de datos de la empresa decía
 * «no encontré nada» sin que nadie pudiera saber por qué.
 *
 * Lo que se defiende aquí no es un caso: es que EL PIE SOBREVIVE. El NIT, la
 * razón social, la dirección y el teléfono viven ahí en cualquier sitio, así
 * que recortar por el principio era la estrategia equivocada en todas las
 * páginas largas, no sólo en ésta.
 */
const pagina = (largo: number, pie: string) => {
  const relleno = 'a'.repeat(largo - pie.length);
  return relleno + pie;
};

describe('recortar una página larga', () => {
  it('el pie sobrevive, que es donde está el NIT', () => {
    const out = clip(pagina(21693, 'NIT: 900.936.153-0'), 20000);
    expect(out).toContain('NIT: 900.936.153-0');
  });

  it('el principio también, que es de lo que trata la página', () => {
    const out = clip(`BBIC S.A.S ofrece envíos${'x'.repeat(30000)}pie`, 20000);
    expect(out).toContain('BBIC S.A.S');
    expect(out).toContain('pie');
  });

  it('dice cuánto se saltó, y por eso no se pueden leer los dos trozos como uno', () => {
    // Un salto silencioso pegaría la primera mitad de una frase con la segunda
    // de otra, y quien lo lea —persona o modelo— creería que era una sola.
    const out = clip('a'.repeat(30000), 20000);
    expect(out).toContain('se omitieron 10000 caracteres');
  });

  it('nunca devuelve más de lo que se pidió, salvo el aviso del medio', () => {
    const out = clip('a'.repeat(50000), 1000);
    const sinAviso = out.replace(/\n*\.\.\. \[[^\]]+\] \.\.\.\n*/, '');
    expect(sinAviso).toHaveLength(1000);
  });

  it('con un texto que cabe no se le llama: esto sólo recorta', () => {
    // El guardarraíl está en quien llama (`raw.length > maxChars`), y esta
    // prueba lo deja escrito para que nadie mueva la condición sin verlo.
    const out = clip('corto', 20000);
    expect(out).toContain('corto');
  });
});
