import { hasLoginSteps } from '@cortex/agent-tools';
import type { Step } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  describeAccountNeed,
  privateArea,
  recordingHasLogin,
  secretFieldNames,
  sessionIdInUrl,
  sessionOnlyPortal,
} from './browser-login';
import type { ProposedStep } from './browser-shape';

/**
 * Detectar que a un trámite le falta la cuenta, que es la diferencia entre
 * preguntar mientras la persona se acuerda y descubrirlo en una corrida de
 * madrugada.
 *
 * El primer bloque es el precio de la copia: `recordingHasLogin` es un espejo
 * de `hasLoginSteps`, que vive en `@cortex/agent-tools` y no se puede importar
 * desde un componente de cliente. Este test corre en Node, importa la real, y
 * falla en cuanto las dos dejen de coincidir.
 */

function step(over: Partial<ProposedStep> & { label: string }): ProposedStep {
  return { action: 'click', targets: [], landmarks: [], ...over };
}

/** Los mismos pasos, con la forma que espera el motor. */
function asEngineSteps(steps: ProposedStep[]): Step[] {
  return steps as unknown as Step[];
}

const CASES: { why: string; steps: ProposedStep[] }[] = [
  { why: 'una consulta sin ingreso', steps: [step({ label: 'Consultar' })] },
  {
    why: 'un paso con credencial vinculada',
    steps: [step({ label: 'Usuario', value: { kind: 'secret', field: 'usuario' } })],
  },
  {
    why: 'un rótulo que dice contraseña, con tilde',
    steps: [step({ label: 'Contraseña', value: { kind: 'literal', text: 'x' } })],
  },
  {
    why: 'un rótulo que dice clave',
    steps: [step({ label: 'Digite su clave de acceso' })],
  },
  {
    why: 'la palabra sólo en el selector, no en el rótulo',
    steps: [step({ label: 'Segundo campo', targets: [{ kind: 'name', value: 'txtPassword' }] })],
  },
  {
    why: 'una placa, que no es una clave aunque se escriba',
    steps: [step({ label: 'Número de placa', value: { kind: 'template', text: '{{placa}}' } })],
  },
];

describe('la copia de cliente de «esta grabación tiene un ingreso»', () => {
  for (const testCase of CASES) {
    it(`coincide con el motor: ${testCase.why}`, () => {
      expect(recordingHasLogin(testCase.steps)).toBe(hasLoginSteps(asEngineSteps(testCase.steps)));
    });
  }
});

describe('los campos que hay que pedir', () => {
  it('usa los nombres que los pasos van a buscar, en orden y sin repetir', () => {
    // Si el formulario guardara «password» y el paso pidiera «clave», el
    // trámite teclearía una cadena vacía y el portal lo rechazaría sin que
    // nadie entienda por qué.
    const steps = [
      step({ label: 'Usuario', value: { kind: 'secret', field: 'usuario' } }),
      step({ label: 'Contraseña', value: { kind: 'secret', field: 'contrasena' } }),
      step({ label: 'Contraseña otra vez', value: { kind: 'secret', field: 'contrasena' } }),
    ];
    expect(secretFieldNames(steps)).toEqual(['usuario', 'contrasena']);
  });

  it('cae en usuario y clave cuando la grabación nunca mostró la puerta', () => {
    expect(secretFieldNames([step({ label: 'Descargar el certificado' })])).toEqual([
      'usuario',
      'clave',
    ]);
  });
});

describe('las pistas de la dirección', () => {
  it('reconoce un portal que no existe fuera de una sesión, y sus subdominios', () => {
    expect(sessionOnlyPortal('https://muisca.dian.gov.co/WebArquitectura/def.faces')).toBe(
      'el MUISCA de la DIAN',
    );
    expect(sessionOnlyPortal('https://acme.siigo.com/inicio')).toBe('Siigo');
  });

  it('no confunde un portal público con uno de sesión', () => {
    // La consulta de placa del RUNT y el RUES son públicos. Preguntar aquí es
    // el ruido que hace que la gente deje de leer los avisos.
    expect(sessionOnlyPortal('https://www.runt.gov.co/consultaCiudadana')).toBeNull();
    expect(sessionOnlyPortal('https://www.rues.org.co/')).toBeNull();
    // Sufijo registrable, no «contiene»: esto no es la DIAN.
    expect(sessionOnlyPortal('https://muisca.dian.gov.co.phishing.co/')).toBeNull();
  });

  it('ve un identificador de sesión metido en la URL', () => {
    expect(sessionIdInUrl('https://portal.gov.co/app;jsessionid=A1B2C3/inicio')).toBe(true);
    expect(sessionIdInUrl('https://portal.gov.co/app?sid=99')).toBe(true);
  });

  it('no llama sesión a cualquier parámetro que termine en id', () => {
    expect(sessionIdInUrl('https://portal.gov.co/app?consultaid=99')).toBe(false);
    expect(sessionIdInUrl('https://portal.gov.co/consulta?placa=ABC123')).toBe(false);
  });

  it('reconoce la zona privada por el subdominio y por la ruta', () => {
    expect(privateArea('https://clientes.operador.com/pedidos')).toBe('clientes.');
    expect(privateArea('https://operador.com/oficina-virtual/facturas')).toBe('/oficina-virtual');
    expect(privateArea('https://www.alcaldia.gov.co/tramites/certificado')).toBeNull();
  });
});

describe('el veredicto', () => {
  const publicSteps = [step({ label: 'Consultar la placa' })];

  it('no pide nada cuando no hay ninguna señal', () => {
    const need = describeAccountNeed({
      steps: publicSteps,
      startUrl: 'https://www.runt.gov.co/consultaCiudadana',
    });
    expect(need.needed).toBe(false);
    expect(need.signal).toBeNull();
  });

  it('pide la cuenta, con certeza, cuando la grabación tiene el ingreso', () => {
    const need = describeAccountNeed({
      steps: [step({ label: 'Contraseña', value: { kind: 'secret', field: 'clave' } })],
      startUrl: 'https://portal.gov.co/entrar',
    });
    expect(need).toMatchObject({ needed: true, signal: 'grabacion', certain: true });
    // Hay pasos donde escribir la clave, así que guardarla SÍ arregla el
    // trámite. Es el único caso en que eso es verdad.
    expect(need.loginNeverTaught).toBe(false);
    expect(need.fields).toEqual(['clave']);
  });

  it('marca «nunca se enseñó el ingreso» cuando la señal viene de la dirección', () => {
    // La regla 0 de classify.ts: quien grabó ya estaba adentro, así que la
    // grabación nunca mostró la puerta y la clave sola no alcanza.
    const need = describeAccountNeed({
      steps: publicSteps,
      startUrl: 'https://muisca.dian.gov.co/WebArquitectura/def.faces',
    });
    expect(need).toMatchObject({
      needed: true,
      signal: 'portal-de-sesion',
      loginNeverTaught: true,
    });
    // Una pista no es un hecho, y la pantalla tiene que poder decirlo.
    expect(need.certain).toBe(false);
  });

  it('cree al portal antes que a cualquier deducción', () => {
    const need = describeAccountNeed({
      steps: publicSteps,
      startUrl: 'https://www.runt.gov.co/consultaCiudadana',
      verificationSaidLogin: true,
    });
    expect(need).toMatchObject({
      needed: true,
      signal: 'verificacion',
      certain: true,
      loginNeverTaught: true,
    });
  });

  it('nunca deja un motivo vacío cuando pide algo', () => {
    const urls = [
      'https://muisca.dian.gov.co/x',
      'https://portal.gov.co/app;jsessionid=A1',
      'https://clientes.operador.com/pedidos',
    ];
    for (const startUrl of urls) {
      const need = describeAccountNeed({ steps: publicSteps, startUrl });
      expect(need.title.length).toBeGreaterThan(0);
      expect(need.reason.length).toBeGreaterThan(0);
      expect(need.fields.length).toBeGreaterThan(0);
    }
  });
});
