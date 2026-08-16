import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintBlobToken, verifyBlobToken } from './blob-token';

const SECRET = 'test-jobs-secret-for-blob-tokens';

describe('blob tokens', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.JOBS_SECRET;
    process.env.JOBS_SECRET = SECRET;
  });

  afterEach(() => {
    // No `delete` (lint) y no `= undefined` (pondría la cadena "undefined"):
    // la cadena vacía es lo que secret() ya trata como "no configurado".
    process.env.JOBS_SECRET = previous ?? '';
  });

  it('hace la ida y vuelta: lo que se firma es lo que se lee', () => {
    const payload = {
      bucket: 'kb-uploads',
      path: 'user-1/doc-2/reunion.m4a',
      expiresAt: Date.now() + 60_000,
    };
    const token = mintBlobToken(payload);
    expect(verifyBlobToken(token)).toEqual(payload);
  });

  it('rechaza un token expirado', () => {
    const token = mintBlobToken({
      bucket: 'kb-uploads',
      path: 'a/b/c.mp3',
      expiresAt: Date.now() - 1,
    });
    expect(verifyBlobToken(token)).toBeNull();
  });

  it('rechaza una firma inválida — un payload alterado no pasa', () => {
    const token = mintBlobToken({
      bucket: 'kb-uploads',
      path: 'a/b/c.mp3',
      expiresAt: Date.now() + 60_000,
    });
    const [encoded = '', signature = ''] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({
        bucket: 'kb-uploads',
        path: 'OTRO/archivo.mp3',
        expiresAt: Date.now() + 60_000,
      }),
      'utf8',
    ).toString('base64url');
    expect(verifyBlobToken(`${tampered}.${signature}`)).toBeNull();
    // Y una firma de otro secreto tampoco.
    process.env.JOBS_SECRET = 'otro-secreto-distinto';
    expect(verifyBlobToken(`${encoded}.${signature}`)).toBeNull();
  });

  it('rechaza basura sin explotar', () => {
    expect(verifyBlobToken('')).toBeNull();
    expect(verifyBlobToken('sin-punto')).toBeNull();
    expect(verifyBlobToken('.')).toBeNull();
    expect(verifyBlobToken('aaa.')).toBeNull();
    expect(verifyBlobToken('!!!.???')).toBeNull();
  });

  it('sin JOBS_SECRET: firmar lanza y verificar dice que no', () => {
    const token = mintBlobToken({
      bucket: 'kb-uploads',
      path: 'a/b/c.mp3',
      expiresAt: Date.now() + 60_000,
    });
    process.env.JOBS_SECRET = '';
    expect(() => mintBlobToken({ bucket: 'x', path: 'y', expiresAt: Date.now() + 1000 })).toThrow(
      /JOBS_SECRET/,
    );
    expect(verifyBlobToken(token)).toBeNull();
  });
});
