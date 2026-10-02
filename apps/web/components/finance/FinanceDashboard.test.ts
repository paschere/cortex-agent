import { fixtureDashboard } from '@/app/v/finanzas-showcase/data';
import { PAYROLL_LABEL } from '@/lib/finance/dashboard-shape';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinanceDashboard } from './FinanceDashboard';
import type { FinanceActions, FinanceLinks } from './types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const links: FinanceLinks = {
  self: '/finance?workspace=org-1',
  chat: '/chat?workspace=org-1',
  payments: '/payments?workspace=org-1',
  bankImport: '/payments?workspace=org-1#extractos',
  accounting: '/integrations?workspace=org-1#programas-contables',
};

const ok = async () => ({ ok: true as const, note: 'ok' });
const actions: FinanceActions = {
  updateBalance: ok,
  saveScenario: ok,
  deleteScenario: ok,
  declareRecurring: ok,
  decideRecurring: ok,
};

const base: Parameters<typeof fixtureDashboard>[0] = {
  isAdmin: true,
  empty: false,
  failing: false,
  scenarioId: null,
  includeEstimatedSales: true,
  minimumCash: null,
};

function render(opts: Partial<typeof base> = {}) {
  return renderToStaticMarkup(
    createElement(FinanceDashboard, {
      data: fixtureDashboard({ ...base, ...opts }),
      links,
      actions,
    }),
  );
}

describe('el panel de Finanzas', () => {
  it('pinta todas las secciones con las cifras de la empresa', () => {
    const html = render();
    for (const title of [
      'Caja hoy',
      'Flujo de caja, 13 semanas',
      'Escenarios',
      'Resultados del mes',
      'Quién me debe',
      'A quién le debo',
      'Gastos fijos',
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain('$ 60.500.000');
    expect(html).toContain('Ver como tabla');
    expect(html).toContain('Incluir ventas estimadas');
    expect(html).toContain('Nexa se atrasa');
    // Las preguntas rápidas van al chat de la empresa, con contexto.
    expect(html).toMatch(/href="\/chat\?workspace=org-1&amp;prompt=%C2%BFMe\+alcanza/);
    expect(html).toContain('Confirmar');
  });

  it('con un escenario abierto dice la comparación en una frase', () => {
    const html = render({ scenarioId: 'esc-nexa' });
    expect(html).toContain('Si Nexa paga 30 días más tarde');
    expect(html).toContain('Borrar escenario');
  });

  it('para quien no administra, la nómina es un total y no hay botones de admin', () => {
    const html = render({ isAdmin: false });
    expect(html).toContain(PAYROLL_LABEL);
    expect(html).not.toMatch(/quincena/i);
    expect(html).not.toContain('Confirmar');
    expect(html).not.toContain('Agregar uno');
    expect(html).not.toContain('Actualizar saldo');
  });

  it('una lectura caída deja su sección en «sin dato» y el resto en pie', () => {
    const html = render({ failing: true });
    expect(html).toContain('Sin dato.');
    expect(html).toContain('Flujo de caja, 13 semanas');
    expect(html).toContain('$ 60.500.000');
  });

  it('una empresa sin nada en el libro ve una sola tarjeta con por dónde empezar', () => {
    const html = render({ empty: true });
    expect(html).toContain('Conectar programa contable');
    expect(html).toContain('Subir extracto');
    expect(html).toContain('Registrar hablando con Cortex');
    expect(html).not.toContain('Flujo de caja, 13 semanas');
  });
});
