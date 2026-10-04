import { describe, expect, it } from 'vitest';
import { looksLikeEmail, parseEmailList } from './invitation-input';

describe('pegar varios correos', () => {
  it('separa por comas, espacios, saltos de línea y punto y coma', () => {
    const { valid } = parseEmailList('a@x.co, b@x.co;c@x.co\nd@x.co  e@x.co');
    expect(valid).toEqual(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co', 'e@x.co']);
  });

  it('quita repetidos sin distinguir mayúsculas y los cuenta', () => {
    const parsed = parseEmailList('Ana@X.co ana@x.co ANA@x.co otra@x.co');
    expect(parsed.valid).toEqual(['ana@x.co', 'otra@x.co']);
    expect(parsed.duplicates).toBe(2);
  });

  it('separa lo que no parece un correo en vez de tirarlo', () => {
    const parsed = parseEmailList('ana@x.co, hola, bob@, @x.co, bob@x');
    expect(parsed.valid).toEqual(['ana@x.co']);
    expect(parsed.invalid).toEqual(['hola', 'bob@', '@x.co', 'bob@x']);
  });

  it('entiende «Nombre <correo>» como lo pega un cliente de correo', () => {
    const parsed = parseEmailList('Ana Restrepo <ana@x.co>, "Luis, Pérez" <luis@x.co>');
    expect(parsed.valid).toContain('ana@x.co');
    expect(parsed.valid).toContain('luis@x.co');
  });

  it('ignora la puntuación pegada al final', () => {
    expect(parseEmailList('(ana@x.co).').valid).toEqual(['ana@x.co']);
  });

  it('un texto vacío no da nada', () => {
    expect(parseEmailList('  \n ,; ')).toEqual({ valid: [], invalid: [], duplicates: 0 });
  });

  it('looksLikeEmail rechaza espacios y arrobas dobles', () => {
    expect(looksLikeEmail('a b@x.co')).toBe(false);
    expect(looksLikeEmail('a@@x.co')).toBe(false);
    expect(looksLikeEmail('a@x.co')).toBe(true);
  });
});
