import { describe, expect, it } from 'vitest';
import { getTool } from '../index';
import { safeFilename } from './storage';

describe('presentations registration smoke', () => {
  it('registers the three tools', () => {
    for (const id of [
      'presentations.pick_candidate',
      'presentations.create_pdf',
      'presentations.list_recent',
    ]) {
      expect(getTool(id), id).toBeDefined();
    }
    expect(getTool('presentations.create_pdf')?.requiresConfirmation).toBe(true);
  });

  it('produces header-safe filenames', () => {
    expect(safeFilename('José Peña_Presentation.pdf')).toBe('Jose_Pena_Presentation.pdf');
    expect(safeFilename('')).toBe('presentation.pdf');
  });
});
