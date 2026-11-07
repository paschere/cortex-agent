import { SDK_OPS } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { buildPrintDoc, sanitizePrintHtml } from './print-html';

describe('sanitizePrintHtml', () => {
  it('quita script, iframe, object, embed y base', () => {
    const out = sanitizePrintHtml(
      '<p>Hola</p><script>alert(1)</script><iframe src="x"></iframe><object data="x"></object><embed src="x"><base href="//evil"><SCRIPT src=a></SCRIPT >',
    );
    expect(out).toBe('<p>Hola</p>');
  });
  it('quita meta http-equiv pero deja otras', () => {
    const out = sanitizePrintHtml(
      '<meta http-equiv="refresh" content="0;url=//x"><meta charset="utf-8">',
    );
    expect(out).toBe('<meta charset="utf-8">');
  });
  it('quita atributos on*', () => {
    const out = sanitizePrintHtml(
      '<img src="a.png" onerror="x()"><b onclick=\'y()\'>t</b><i/onmouseover=z()>q</i>',
    );
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('onmouseover');
    expect(out).toContain('src="a.png"');
    expect(out).toContain('>t</b>');
  });
  it('neutraliza URLs javascript:', () => {
    const out = sanitizePrintHtml(
      '<a href="javascript:alert(1)">a</a><a href=" JaVa\tScRiPt:x">b</a><div style="background:url(javascript:x)">c</div>',
    );
    expect(out.toLowerCase()).not.toContain('javascript');
  });
  it('conserva HTML normal e imágenes data:', () => {
    const html =
      '<table><tr><td style="color:red">1</td></tr></table><img src="data:image/png;base64,AAA">';
    expect(sanitizePrintHtml(html)).toBe(html);
  });
});

describe('buildPrintDoc', () => {
  it('pone el título sin caracteres peligrosos', () => {
    expect(buildPrintDoc('<p>x</p>', 'A<b>"&')).toContain('<title>Ab</title>');
  });
});

describe('ui.print', () => {
  it('no es una op de servidor', () => {
    expect((SDK_OPS as readonly string[]).includes('ui.print')).toBe(false);
  });
});
