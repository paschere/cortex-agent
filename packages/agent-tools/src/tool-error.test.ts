import { describe, expect, it } from 'vitest';
import { toolErrorDetail, toolErrorMessage } from './tool-error';

/**
 * The regression this file pins down.
 *
 * `cortex.remember` failed on every attempt and the chat card said, in full:
 *
 *     { "__error": true, "tool": "cortex.remember", "message": "[object Object]" }
 *
 * The message came from `String(err)` on a value that was not an `Error`. It is
 * worth being precise about why that was not a small bug: supabase-js returns
 * `{ data, error }` where `error` is a PLAIN OBJECT, and the whole product
 * writes `if (error) throw error`. So the one line that was wrong was the line
 * every database failure in every tool went through, and it destroyed the cause
 * before the logger, the audit row or the model could see it. The real defect
 * underneath took four migrations' worth of reading to find because of it.
 *
 * The claim under test is therefore blunt and absolute: whatever is thrown, the
 * envelope gets something a person can read, and never "[object Object]".
 */

const NEVER = '[object Object]';

describe('toolErrorMessage', () => {
  it('reads a PostgrestError, which is a plain object and not an Error', () => {
    // Exactly what PostgREST returned for the failure that started this: the
    // writer function had never learned to fill in the column migration 0064
    // made mandatory.
    const err = {
      code: '23502',
      details: 'Failing row contains (…, null, Prefiere respuestas directas…).',
      hint: null,
      message:
        'null value in column "organization_id" of relation "user_memories" violates not-null constraint',
    };

    const message = toolErrorMessage(err);

    expect(message).not.toBe(NEVER);
    expect(message).not.toContain('object Object');
    expect(message).toContain('organization_id');
    expect(message).toContain('not-null constraint');
    // The SQL state and the row detail are what make the report actionable.
    expect(message).toContain('23502');
    expect(message).toContain('Failing row contains');
  });

  it('reads a PostgrestError thrown as the class, identically', () => {
    // `.throwOnError()` produces an Error subclass instead. Same fields, so the
    // reader must not care which one it got.
    class PostgrestError extends Error {
      details: string | null = 'Key (user_id)=(…) is not present in table "users".';
      hint: string | null = null;
      code: string | null = '23503';
      constructor(message: string) {
        super(message);
        this.name = 'PostgrestError';
      }
    }

    const message = toolErrorMessage(new PostgrestError('insert violates foreign key constraint'));

    expect(message).toContain('insert violates foreign key constraint');
    expect(message).toContain('23503');
    expect(message).toContain('not present in table');
  });

  it('reads a ZodError as its issues, not as re-serialised JSON', () => {
    const err = {
      name: 'ZodError',
      issues: [
        { path: ['memory'], message: 'String must contain at least 3 character(s)' },
        { path: ['kind'], message: "Invalid enum value. Expected 'fact' | 'preference'" },
      ],
      message: '[\n  {\n    "code": "too_small"\n  }\n]',
    };

    const message = toolErrorMessage(err);

    expect(message).toContain('memory: String must contain at least 3 character(s)');
    expect(message).toContain('kind: Invalid enum value');
    expect(message).not.toContain('too_small');
  });

  it('summarises a long issue list instead of dumping it', () => {
    const err = {
      name: 'ZodError',
      issues: Array.from({ length: 9 }, (_, i) => ({ path: [`f${i}`], message: 'Required' })),
    };
    expect(toolErrorMessage(err)).toContain('(y 4 más)');
  });

  it('reads an ordinary Error', () => {
    expect(toolErrorMessage(new Error('Gmail token expired'))).toBe('Gmail token expired');
  });

  it('reads a thrown string, and unwraps a provider JSON envelope inside it', () => {
    expect(toolErrorMessage('plain trouble')).toBe('plain trouble');
    expect(
      toolErrorMessage(
        'Google API error: {"error":{"code":403,"message":"Request had insufficient authentication scopes."}}',
      ),
    ).toBe('Request had insufficient authentication scopes.');
  });

  it('reads an unrecognised object as bounded JSON rather than as "[object Object]"', () => {
    const message = toolErrorMessage({ status: 502, upstream: 'browser-service' });
    expect(message).not.toBe(NEVER);
    expect(message).toContain('browser-service');
    expect(message).toContain('502');
  });

  it('survives what cannot be serialised, and says something either way', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(toolErrorMessage(circular)).not.toBe(NEVER);

    // Nothing legible at all still has to produce a sentence — the envelope has
    // no other field to carry the news.
    for (const nothing of [null, undefined, {}, new Error('')]) {
      const message = toolErrorMessage(nothing);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(NEVER);
    }
  });

  it('falls through to the cause when an Error carries no message of its own', () => {
    const err = new Error('', {
      cause: { message: 'connection reset by peer', code: 'ECONNRESET' },
    });
    expect(toolErrorMessage(err)).toContain('connection reset by peer');
  });

  it('caps the message so a giant error body cannot flood the model context', () => {
    const message = toolErrorMessage(new Error('x'.repeat(50_000)));
    expect(message.length).toBeLessThanOrEqual(601);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('toolErrorDetail', () => {
  it('keeps for the log what the message had to drop', () => {
    const detail = toolErrorDetail({
      code: '23502',
      details: 'Failing row contains (…).',
      hint: null,
      message: 'null value in column "organization_id" violates not-null constraint',
    });

    expect(detail.kind).toBe('PostgrestError');
    expect(detail.code).toBe('23502');
    expect(detail.details).toBe('Failing row contains (…).');
    // A thrown plain object has no stack, so the object itself is the evidence.
    expect(String(detail.raw)).toContain('organization_id');
  });

  it('keeps the stack when there is one', () => {
    const detail = toolErrorDetail(new Error('boom'));
    expect(detail.kind).toBe('Error');
    expect(String(detail.stack)).toContain('boom');
  });
});
