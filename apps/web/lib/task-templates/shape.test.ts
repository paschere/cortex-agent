import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from './catalog';
import { fillPrompt, needMet, placeholdersOf, titleWith, validateTemplateInput } from './shape';

describe('galería de siempre', () => {
  it('trae doce plantillas generales, con ids únicos y datos completos', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(12);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(12);
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.title.length).toBeGreaterThanOrEqual(3);
      expect(t.summary.length).toBeGreaterThanOrEqual(5);
      expect(t.prompt.length).toBeLessThanOrEqual(6000);
      expect(t.minutes).toBeGreaterThan(0);
      // Los huecos del texto son los campos que pide la tarjeta.
      expect(t.fields.map((f) => f.key).sort()).toEqual(
        [...new Set([...placeholdersOf(t.prompt)])].sort(),
      );
      // Siempre piden plan y confirmación: la regla de fondo.
      expect(t.prompt).toMatch(/plan/);
      expect(t.prompt).toMatch(/confirmaci[oó]n|aprobaci[oó]n|aprobar/);
    }
  });
});

describe('huecos', () => {
  it('llena los huecos y dice cuáles faltan', () => {
    const p = 'Compara {{producto}} y {{producto}} en {{ciudad}}';
    expect(placeholdersOf(p)).toEqual(['producto', 'ciudad']);
    expect(fillPrompt(p, { producto: 'papel', ciudad: 'Cali' })).toEqual({
      prompt: 'Compara papel y papel en Cali',
      missing: [],
    });
    expect(fillPrompt(p, { producto: 'papel' }).missing).toEqual(['ciudad']);
    expect(fillPrompt(p, { producto: '   ', ciudad: 'x' }).missing).toEqual(['producto']);
  });

  it('el título muestra «…» donde falta el valor', () => {
    expect(titleWith('Investiga a {{cliente}}')).toBe('Investiga a …');
    expect(titleWith('Investiga a {{cliente}}', { cliente: 'Acme' })).toBe('Investiga a Acme');
  });

  it('las necesidades dicen si están conectadas', () => {
    expect(needMet('siigo', ['siigo'])).toBe(true);
    expect(needMet('accounting', ['alegra'])).toBe(true);
    expect(needMet('gmail', ['hubspot'])).toBe(false);
    expect(needMet('bank_file', [])).toBeNull();
  });
});

describe('validateTemplateInput', () => {
  const ok = {
    title: 'Revisar cierre',
    summary: 'Revisa el cierre del mes.',
    prompt: 'Revisa el cierre de {{mes}} y dime qué falta.',
    needs: ['accounting'],
    minutes: 12,
  };
  it('acepta una plantilla válida y la normaliza', () => {
    const r = validateTemplateInput({
      ...ok,
      title: '  Revisar   cierre ',
      needs: ['accounting', 'accounting'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Revisar cierre');
      expect(r.value.needs).toEqual(['accounting']);
    }
  });
  it('rechaza lo mal formado', () => {
    expect(validateTemplateInput(null).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, title: 'ab' }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, summary: 'hola' }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, prompt: 'corto' }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, prompt: 'x'.repeat(6001) }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, needs: ['rm -rf'] }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, minutes: 0 }).ok).toBe(false);
    expect(validateTemplateInput({ ...ok, minutes: 500 }).ok).toBe(false);
    expect(
      validateTemplateInput({ ...ok, prompt: 'Haz {{a}} {{b}} {{c}} {{d}} {{e}} {{f}} todo' }).ok,
    ).toBe(false);
    expect(validateTemplateInput({ ...ok, prompt: 'Haz {{mal y no cierra' }).ok).toBe(false);
  });
});
