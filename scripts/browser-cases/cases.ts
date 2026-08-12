import type { Page } from '../../services/browser/node_modules/playwright';
import type { Variable } from '../../packages/agent-tools/src/browser/types';
import type { Act } from './record';

/**
 * The three errands, as a person would demonstrate them.
 *
 * `prelude` is what the person does BEFORE pressing record -- and for the first
 * errand that is the whole login, which is precisely why that errand is here.
 * Nothing in `prelude` is photographed, exactly as nothing before the share
 * dialog is photographed in the product.
 */

export interface Case {
  id: string;
  name: string;
  /** What the person types into "¿qué estás haciendo?" before recording. */
  hint: string;
  /** Where the errand starts. The person fixes this on the review screen. */
  startUrl(portal: string): string;
  /** Done before the camera is on. */
  prelude(page: Page, portal: string): Promise<void>;
  acts(portal: string): Act[];
  /** How many steps the errand really has. The denominator. */
  groundTruthSteps: number;
  /**
   * Values to replay with, matched to whatever the model chose to call them.
   * Deliberately NOT the values that were demonstrated -- see `conAcceso`.
   */
  inputs: { match: RegExp; value: string }[];
  /**
   * The values the person used while teaching. What the verification pass runs
   * with in the product (`sample` in POST /api/browser/flows), and therefore
   * what any refinement is derived from.
   */
  teachInputs: { match: RegExp; value: string }[];
  /** The errand worked if any extracted value contains this. */
  expects: string;
  /** True when a replay from a clean browser cannot even start without a login. */
  needsSession: boolean;
  /** The bound credential, decrypted, as `unlockForRun` would hand it over. */
  secrets?: Record<string, string>;
}

/** Resolve the run's inputs against the variable names the model invented. */
export function inputsFor(
  testCase: Case,
  variables: Variable[],
  which: 'replay' | 'teach' = 'replay',
): Record<string, string> {
  const rules = which === 'teach' ? testCase.teachInputs : testCase.inputs;
  const out: Record<string, string> = {};
  for (const variable of variables) {
    const rule = rules.find((r) => r.match.test(variable.name));
    out[variable.name] = rule ? rule.value : variable.example || 'X';
  }
  return out;
}

const DEMO = {
  usuario: 'contadora@acme.co',
  clave: 'Clave-De-Prueba-2026',
  documento: '901348271',
  nombre: 'María Fernanda Osorio',
  cedula: '52884109',
  correo: 'mfosorio@acme.co',
  telefono: '3105557788',
  descripcion: 'Traslado de la sede principal a la calle 10 sur 43-12.',
  factura: 'F-00312',
};

async function signIn(page: Page, portal: string): Promise<void> {
  await page.goto(`${portal}/entrar`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Usuario').fill(DEMO.usuario);
  await page.getByLabel('Contraseña').fill(DEMO.clave);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await page.waitForLoadState('domcontentloaded');
}

// ---------------------------------------------------------------------------

const conAcceso: Case = {
  id: 'acceso',
  name: 'Certificado de antecedentes (detrás de un ingreso)',
  hint: 'Saco el certificado de antecedentes de un NIT desde el panel del portal.',
  // The person starts recording on the panel, because that is where they are.
  startUrl: (portal) => `${portal}/panel`,
  prelude: signIn,
  acts: (portal) => [
    {
      note: 'abre el certificado de antecedentes',
      selector: 'a[href="/panel/certificado"]',
      heavy: true,
      run: (page) => page.getByRole('link', { name: 'Certificado de antecedentes' }).click(),
    },
    {
      note: 'elige el tipo de documento',
      selector: '#ddlTipoDoc',
      run: (page) => page.getByLabel('Tipo de documento').selectOption({ label: 'NIT' }),
    },
    {
      note: 'escribe el número',
      selector: '#txtDocumento',
      run: (page) => page.getByLabel('Número de documento').fill(DEMO.documento),
    },
    {
      note: 'genera el certificado',
      selector: 'button[name="btnGenerar"]',
      heavy: true,
      run: (page) => page.getByRole('button', { name: 'Generar certificado' }).click(),
    },
  ],
  groundTruthSteps: 6,
  // NOT the document that was demonstrated. Replaying an errand with the values
  // it was taught with proves only that the recording can be re-enacted; the
  // question worth answering is whether it works for the NEXT one, and a step
  // that reads the answer by pointing at the answer it saw fails exactly here.
  inputs: [{ match: /doc|nit|numero|cedula/i, value: '830052780' }],
  teachInputs: [{ match: /doc|nit|numero|cedula/i, value: DEMO.documento }],
  expects: 'SIN ANTECEDENTES',
  needsSession: true,
};

/**
 * The same errand, taught the way improvement 4 asks for: the person is told to
 * log out first and record the login too. Same portal, same goal, and the only
 * difference is whether the recording contains the door.
 */
const conAccesoGrabado: Case = {
  ...conAcceso,
  id: 'acceso-grabado',
  name: 'Certificado de antecedentes (grabando también el ingreso)',
  hint: 'Entro al portal y saco el certificado de antecedentes de un NIT.',
  startUrl: (portal) => `${portal}/entrar`,
  prelude: async (page, portal) => {
    await page.goto(`${portal}/entrar`, { waitUntil: 'domcontentloaded' });
  },
  acts: (portal) => [
    {
      note: 'escribe el usuario',
      selector: '#txtUsuario',
      run: (page) => page.getByLabel('Usuario').fill(DEMO.usuario),
    },
    {
      note: 'escribe la contraseña',
      selector: '#txtClave',
      run: (page) => page.getByLabel('Contraseña').fill(DEMO.clave),
    },
    {
      note: 'entra',
      selector: 'button[name="btnIngresar"]',
      heavy: true,
      run: (page) => page.getByRole('button', { name: 'Ingresar' }).click(),
    },
    ...conAcceso.acts(portal),
  ],
  groundTruthSteps: 9,
  needsSession: false,
  secrets: { usuario: DEMO.usuario, clave: DEMO.clave },
};

const formularioLargo: Case = {
  id: 'formulario',
  name: 'Formulario largo con un campo dependiente',
  hint: 'Radico una novedad de cambio de dirección en el formulario del portal.',
  startUrl: (portal) => `${portal}/novedad`,
  prelude: async (page, portal) => {
    await page.goto(`${portal}/novedad`, { waitUntil: 'domcontentloaded' });
  },
  acts: () => [
    {
      note: 'nombre',
      selector: '#txtNombre',
      run: (page) => page.getByLabel('Nombre completo').fill(DEMO.nombre),
    },
    {
      note: 'documento',
      selector: '#txtDocumento',
      run: (page) => page.getByLabel('Número de documento').fill(DEMO.cedula),
    },
    {
      note: 'correo',
      selector: '#txtCorreo',
      run: (page) => page.getByLabel('Correo electrónico').fill(DEMO.correo),
    },
    {
      note: 'teléfono',
      selector: '#txtTelefono',
      run: (page) => page.getByLabel('Teléfono de contacto').fill(DEMO.telefono),
    },
    {
      note: 'departamento — y esto es lo que llena el desplegable de ciudad',
      selector: '#ddlDepartamento',
      heavy: true,
      run: (page) => page.getByLabel('Departamento').selectOption({ label: 'Antioquia' }),
    },
    {
      note: 'ciudad, que sólo existe después de elegir departamento',
      selector: '#ddlCiudad',
      run: (page) => page.getByLabel('Ciudad').selectOption({ label: 'Envigado' }),
    },
    {
      note: 'tipo de novedad',
      selector: '#ddlTipoNovedad',
      run: (page) =>
        page.getByLabel('Tipo de novedad').selectOption({ label: 'Cambio de dirección' }),
    },
    {
      note: 'descripción',
      selector: '#txtDescripcion',
      run: (page) => page.getByLabel('Descripción de la novedad').fill(DEMO.descripcion),
    },
    {
      note: 'autoriza el tratamiento de datos',
      selector: '#chkAutorizo',
      run: (page) => page.getByLabel('Autorizo el tratamiento').check(),
    },
    {
      note: 'radica',
      selector: 'button[name="btnRadicar"]',
      heavy: true,
      run: (page) => page.getByRole('button', { name: 'Radicar novedad' }).click(),
    },
  ],
  groundTruthSteps: 12,
  inputs: [
    { match: /nombre/i, value: DEMO.nombre },
    { match: /correo|mail/i, value: DEMO.correo },
    { match: /tel|celular/i, value: DEMO.telefono },
    { match: /descrip|detalle|observ/i, value: DEMO.descripcion },
    { match: /depart/i, value: 'Antioquia' },
    { match: /ciudad|municipio/i, value: 'Envigado' },
    { match: /tipo/i, value: 'Cambio de dirección' },
    { match: /doc|cedula|nit|identif/i, value: DEMO.cedula },
  ],
  teachInputs: [
    { match: /nombre/i, value: DEMO.nombre },
    { match: /correo|mail/i, value: DEMO.correo },
    { match: /tel|celular/i, value: DEMO.telefono },
    { match: /descrip|detalle|observ/i, value: DEMO.descripcion },
    { match: /depart/i, value: 'Antioquia' },
    { match: /ciudad|municipio/i, value: 'Envigado' },
    { match: /tipo/i, value: 'Cambio de dirección' },
    { match: /doc|cedula|nit|identif/i, value: DEMO.cedula },
  ],
  expects: 'NV-2026-00742',
  needsSession: false,
};

const tablaDeResultados: Case = {
  id: 'tabla',
  name: 'Tabla de resultados: leer el dato de la fila correcta',
  hint: 'Busco las facturas de un NIT y miro el estado de cartera de una factura en particular.',
  startUrl: (portal) => `${portal}/facturas`,
  prelude: async (page, portal) => {
    await page.goto(`${portal}/facturas`, { waitUntil: 'domcontentloaded' });
  },
  acts: () => [
    {
      note: 'escribe el NIT',
      selector: '#txtNit',
      run: (page) => page.getByLabel('Número de NIT').fill(DEMO.documento),
    },
    {
      note: 'busca',
      selector: 'button[name="btnBuscar"]',
      heavy: true,
      run: (page) => page.getByRole('button', { name: 'Buscar' }).click(),
    },
    {
      note: 'abre el detalle de la factura que interesa — la tercera fila',
      selector: `a[aria-label="Ver detalle de la factura ${DEMO.factura}"]`,
      heavy: true,
      run: (page) =>
        page.getByRole('link', { name: `Ver detalle de la factura ${DEMO.factura}` }).click(),
    },
  ],
  groundTruthSteps: 5,
  inputs: [
    { match: /nit|documento/i, value: '830114921' },
    { match: /factura|numero|radicado/i, value: DEMO.factura },
  ],
  teachInputs: [
    { match: /nit|documento/i, value: DEMO.documento },
    { match: /factura|numero|radicado/i, value: DEMO.factura },
  ],
  expects: 'EN MORA',
  needsSession: false,
};

export const CASES: Case[] = [conAcceso, conAccesoGrabado, formularioLargo, tablaDeResultados];
export const EXTRA_CASES: Case[] = [];
export { DEMO };
