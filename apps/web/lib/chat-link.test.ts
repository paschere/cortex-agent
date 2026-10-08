import { describe, expect, it } from 'vitest';
import { looksLikeUrl, shortLinkLabel } from './chat-link';

describe('shortLinkLabel', () => {
  it('deja el dominio y recorta la ruta larga', () => {
    const url = 'https://drive.google.com/drive/folders/12ZKgFFQW5jZ4rTxK97b43QQvXV4tG-AI';
    const label = shortLinkLabel(url);
    expect(label.startsWith('drive.google.com/drive/folders/')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(44);
  });
  it('no toca una dirección corta y quita www', () => {
    expect(shortLinkLabel('https://www.ejemplo.com/')).toBe('ejemplo.com');
  });
});

describe('looksLikeUrl', () => {
  it('sólo reconoce texto que es una URL entera', () => {
    expect(looksLikeUrl('https://a.co/x')).toBe(true);
    expect(looksLikeUrl('ver https://a.co/x')).toBe(false);
    expect(looksLikeUrl('informe')).toBe(false);
  });
});
