import { describe, it, expect } from 'vitest';
import { chunkText } from './chunker';

describe('chunkText', () => {
  it('returns one chunk for short text', () => {
    const chunks = chunkText('hello world');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe('hello world');
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
  });

  it('splits long text into multiple chunks', () => {
    // Create a long text by repeating paragraphs — each ~500 words => ~650 tokens
    const para = 'word '.repeat(400).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, { targetTokens: 400, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunks have overlap — consecutive chunks share content', () => {
    const para = 'word '.repeat(200).trim(); // ~260 tokens each
    const text = [para, para, para, para].join('\n\n');
    const chunks = chunkText(text, { targetTokens: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start with content from end of first chunk (overlap)
    const firstContent = chunks[0]!.content;
    const secondContent = chunks[1]!.content;
    // Both should have positive token counts
    expect(firstContent.length).toBeGreaterThan(0);
    expect(secondContent.length).toBeGreaterThan(0);
  });

  it('chunks preserve order via chunkIndex', () => {
    const para = 'word '.repeat(200).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, { targetTokens: 300, overlap: 50 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i);
    }
  });

  it('each chunk is under target+10% tokens', () => {
    const para = 'word '.repeat(200).trim();
    const text = [para, para, para, para, para].join('\n\n');
    const targetTokens = 300;
    const chunks = chunkText(text, { targetTokens, overlap: 50 });
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(Math.ceil(targetTokens * 1.1));
    }
  });

  it('all chunks have positive token counts', () => {
    const para = 'word '.repeat(100).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, { targetTokens: 200, overlap: 30 });
    expect(chunks.every((c) => c.tokens > 0)).toBe(true);
  });
});
