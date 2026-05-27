import { describe, it, expect } from 'vitest';
import { ValidationError } from '@zipdev/core';
import { parseDocument } from './parsers';

describe('parseDocument', () => {
  it('returns plain text unchanged', async () => {
    const result = await parseDocument(Buffer.from('hello world'), 'text/plain');
    expect(result.text).toBe('hello world');
    expect(result.pages).toBeUndefined();
  });

  it('returns markdown text unchanged', async () => {
    const result = await parseDocument(Buffer.from('# heading\n\nsome text'), 'text/markdown');
    expect(result.text).toContain('# heading');
    expect(result.text).toContain('some text');
  });

  it('throws ValidationError for unsupported mime type', async () => {
    await expect(
      parseDocument(Buffer.from(''), 'application/octet-stream'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError with message containing the mime type', async () => {
    await expect(
      parseDocument(Buffer.from(''), 'image/png'),
    ).rejects.toThrow('image/png');
  });
});
