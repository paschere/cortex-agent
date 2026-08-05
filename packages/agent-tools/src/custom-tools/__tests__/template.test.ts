import { describe, expect, it } from 'vitest';
import { parsePath, selectResponse } from '../response';
import { buildInputSchema } from '../schema';
import { renderBody, renderHeaders, renderUrl, sanitizeHeaderValue } from '../template';

describe('renderUrl', () => {
  it('substitutes and percent-encodes', () => {
    expect(renderUrl('https://erp.co/guias/{{guia}}', { guia: 'AB-12' })).toBe(
      'https://erp.co/guias/AB-12',
    );
  });

  it('a value cannot escape its path segment', () => {
    // Without encoding this reaches /admin/keys. With it, it is one segment.
    const url = renderUrl('https://erp.co/guias/{{guia}}', { guia: '../../admin/keys' });
    expect(url).toBe('https://erp.co/guias/..%2F..%2Fadmin%2Fkeys');
    expect(new URL(url).pathname).toBe('/guias/..%2F..%2Fadmin%2Fkeys');
  });

  it('a value cannot open a second query parameter', () => {
    const url = renderUrl('https://erp.co/buscar?q={{q}}', { q: 'x&admin=true' });
    expect(new URL(url).searchParams.get('q')).toBe('x&admin=true');
    expect(new URL(url).searchParams.get('admin')).toBeNull();
  });

  it('a value cannot change the host by way of an @', () => {
    const url = renderUrl('https://erp.co/{{p}}', { p: '@evil.example' });
    expect(new URL(url).hostname).toBe('erp.co');
  });

  it('an absent optional field renders empty rather than "undefined"', () => {
    expect(renderUrl('https://erp.co/x?y={{y}}', {})).toBe('https://erp.co/x?y=');
  });

  it('accepts inner whitespace in a placeholder', () => {
    expect(renderUrl('https://erp.co/{{ guia }}', { guia: '7' })).toBe('https://erp.co/7');
  });
});

describe('renderHeaders', () => {
  it('strips CR and LF, which is what makes header injection impossible', () => {
    const headers = renderHeaders(
      { 'X-Tenant': '{{tenant}}' },
      { tenant: 'acme\r\nX-Admin: true\r\n' },
    );
    expect(headers['X-Tenant']).toBe('acmeX-Admin: true');
    expect(headers['X-Tenant']).not.toMatch(/[\r\n]/);
  });

  it('strips NUL and other control characters', () => {
    expect(sanitizeHeaderValue('a\u0000b\u0007c')).toBe('abc');
  });

  it('drops reserved and malformed header names', () => {
    const headers = renderHeaders(
      { Host: 'evil.example', 'Content-Length': '0', 'Bad Name': 'x', 'X-Ok': 'y' },
      {},
    );
    expect(Object.keys(headers)).toEqual(['X-Ok']);
  });
});

describe('renderBody — JSON', () => {
  const template = { guia: '{{guia}}', nota: 'guía {{guia}} revisada', cantidad: '{{cantidad}}' };

  it('keeps types: a number stays a number, not a string', () => {
    const { body, contentType } = renderBody('json', template, { guia: 'A1', cantidad: 3 });
    expect(contentType).toBe('application/json');
    expect(JSON.parse(body as string)).toEqual({
      guia: 'A1',
      nota: 'guía A1 revisada',
      cantidad: 3,
    });
  });

  it('THE INJECTION TEST: a hostile value cannot change the shape of the document', () => {
    // This exact string rewrites the request when a template is interpolated
    // textually into hand-written JSON: it closes the string, adds a key, and
    // reopens one. Here it stays a single string value.
    const hostile = '","admin":true,"x":"';
    const { body } = renderBody('json', template, { guia: hostile, cantidad: 1 });
    const parsed = JSON.parse(body as string) as Record<string, unknown>;
    expect(parsed.guia).toBe(hostile);
    expect(parsed.admin).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(['cantidad', 'guia', 'nota']);
  });

  it('survives braces, backslashes and newlines in a value', () => {
    const nasty = '}\\{"a":1}\n\t';
    const { body } = renderBody('json', { v: '{{v}}' }, { v: nasty });
    expect(JSON.parse(body as string)).toEqual({ v: nasty });
  });

  it('drops the key when an optional field is absent, instead of sending null', () => {
    const { body } = renderBody('json', { guia: '{{guia}}', estado: '{{estado}}' }, { guia: 'A1' });
    expect(JSON.parse(body as string)).toEqual({ guia: 'A1' });
  });

  it('passes an array field through as a JSON array', () => {
    const { body } = renderBody('json', { ids: '{{ids}}' }, { ids: ['a', 'b'] });
    expect(JSON.parse(body as string)).toEqual({ ids: ['a', 'b'] });
  });

  it('handles nested structures', () => {
    const { body } = renderBody(
      'json',
      { filtro: { estado: '{{estado}}', paginas: ['{{p}}'] } },
      { estado: 'activo', p: 2 },
    );
    expect(JSON.parse(body as string)).toEqual({ filtro: { estado: 'activo', paginas: [2] } });
  });
});

describe('renderBody — form', () => {
  it('encodes both name and value', () => {
    const { body, contentType } = renderBody('form', { 'a b': '{{v}}' }, { v: 'x&y=z' });
    expect(contentType).toBe('application/x-www-form-urlencoded');
    expect(body).toBe('a%20b=x%26y%3Dz');
  });
});

describe('buildInputSchema', () => {
  const schema = buildInputSchema({
    fields: [
      { name: 'guia', type: 'string', required: true, description: 'Número de guía' },
      { name: 'cantidad', type: 'integer', required: false, description: 'Cuántas' },
      {
        name: 'estado',
        type: 'string',
        required: false,
        description: 'Estado',
        enum: ['activo', 'anulado'],
      },
    ],
  });

  it('requires what is required and rejects the wrong type', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ guia: 'A1' }).success).toBe(true);
    expect(schema.safeParse({ guia: 'A1', cantidad: 1.5 }).success).toBe(false);
  });

  it('enforces a closed set so the model cannot invent a value', () => {
    expect(schema.safeParse({ guia: 'A1', estado: 'activo' }).success).toBe(true);
    expect(schema.safeParse({ guia: 'A1', estado: 'inventado' }).success).toBe(false);
  });

  it('is built from data — no field named in the definition means no key', () => {
    const empty = buildInputSchema({ fields: [] });
    expect(empty.safeParse({}).success).toBe(true);
  });
});

describe('selectResponse', () => {
  const body = JSON.stringify({ data: { guias: [{ estado: 'EN RUTA', id: 1 }] } });

  it('walks a dotted path, with or without bracket indices', () => {
    expect(selectResponse(body, 'data.guias.0.estado', 1000).data).toBe('EN RUTA');
    expect(selectResponse(body, '$.data.guias[0].estado', 1000).data).toBe('EN RUTA');
    expect(parsePath('$.a.b[2].c')).toEqual(['a', 'b', '2', 'c']);
  });

  it('falls back to the whole body when the path matches nothing, and says so', () => {
    const out = selectResponse(body, 'data.noexiste', 1000);
    expect(out.pathMissed).toBe(true);
    expect(out.data).toEqual(JSON.parse(body));
  });

  it('truncates rather than handing the model 200 KB', () => {
    const big = JSON.stringify({ items: new Array(5000).fill('xxxxxxxxxx') });
    const out = selectResponse(big, null, 500);
    expect(out.truncated).toBe(true);
    expect(typeof out.data).toBe('string');
    expect((out.data as string).length).toBeLessThan(700);
  });

  it('keeps a non-JSON body as text so an HTML error page is still readable', () => {
    const out = selectResponse('<html>502 Bad Gateway</html>', 'data.x', 1000);
    expect(out.data).toBe('<html>502 Bad Gateway</html>');
  });
});
