import { ValidationError } from '@zipdev/core';

export interface ParseResult {
  text: string;
  pages?: number;
}

export async function parseDocument(buffer: Buffer, mime: string): Promise<ParseResult> {
  const m = mime.toLowerCase();

  if (m === 'application/pdf') {
    // pdf-parse has a side-effect bug at its entry point — import from the lib directly
    const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const r = await pdf(buffer);
    return { text: r.text, pages: r.numpages };
  }

  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer });
    return { text: r.value };
  }

  if (m === 'text/plain' || m === 'text/markdown' || m === 'text/csv') {
    return { text: buffer.toString('utf-8') };
  }

  throw new ValidationError(`Unsupported file type: ${mime}`);
}
