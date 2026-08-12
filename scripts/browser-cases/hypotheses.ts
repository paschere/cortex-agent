import type { Proposal } from '../../packages/agent-tools/src/browser/extract';

/**
 * What a recording can support, written down once so the engine can be measured
 * without spending a model call.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE EXIST, AND WHAT THEY ARE NOT
 * ---------------------------------------------------------------------------
 * `pnpm browser:cases` runs the real extractor against real frames, which is
 * the honest end-to-end measurement and the one that decides whether a change to
 * the PROMPT is worth anything. It costs a model call per errand and it varies
 * between runs.
 *
 * These are for the other question: whether a change to the REPLAY ENGINE is
 * worth anything. Refinement, classification, the login rule and the ambiguity
 * rule are all downstream of extraction and none of them cares which model
 * produced the step list -- so measuring them through a live model adds cost,
 * variance and nothing else. Fixed hypotheses make those numbers exact and
 * repeatable, and they keep working when there is no key at all.
 *
 * THEY ARE NOT GROUND TRUTH AND MUST NOT BE MISTAKEN FOR IT. They are what a
 * competent reader of PICTURES would write, degraded in the four specific ways a
 * camera forces and no others:
 *
 *   1  No `testid` and no `name`. Neither is rendered. A model that produced one
 *      would be hallucinating, and the system prompt tells it not to.
 *   2  No `css`. Same reason.
 *   3  Paraphrase in the first candidate. Reading a label off a screenshot and
 *      writing it out is a transcription, and transcriptions drift -- "Tipo
 *      documento" for "Tipo de documento". The correct spelling is present
 *      lower down, which is exactly what the ranked list is for.
 *   4  `expect` that over-promises, and an `extract` step that points at the
 *      answer it happened to see. Both are what the live run produced.
 *
 * Every one of those four is a fact about what a photograph contains, not a
 * choice about what makes a change look good. The degradations were fixed
 * BEFORE the improvements were measured, and the live-model baseline in
 * docs/operations/browser.md is what keeps them honest.
 */

export const HYPOTHESES: Record<string, (portal: string) => Proposal> = {
  acceso: (portal) => ({
    name: 'Certificado de antecedentes',
    description: 'Genera el certificado de antecedentes de un documento.',
    startUrl: `${portal}/panel`,
    effect: 'read',
    variables: [
      { name: 'documento', label: 'Número de documento', example: '901348271', required: true },
    ],
    notes: [],
    steps: [
      {
        action: 'goto',
        label: 'Abrir el panel de servicios',
        targets: [],
        url: `${portal}/panel`,
        landmarks: ['Panel de servicios', 'Portal Único de Servicios'],
      },
      {
        action: 'click',
        label: 'Abrir el certificado de antecedentes',
        targets: [
          { kind: 'role', value: 'link', name: 'Certificado de antecedentes' },
          { kind: 'text', value: 'Certificado de antecedentes' },
        ],
        expect: 'Certificado de antecedentes',
        landmarks: ['Panel de servicios'],
      },
      {
        action: 'select',
        label: 'Elegir el tipo de documento',
        // The label is misread by one word. This is the ordinary case.
        targets: [
          { kind: 'label', value: 'Tipo documento' },
          { kind: 'role', value: 'combobox', name: 'Tipo de documento' },
        ],
        value: { kind: 'literal', text: 'NIT' },
        landmarks: ['Certificado de antecedentes'],
      },
      {
        action: 'fill',
        label: 'Escribir el número de documento',
        // A placeholder that is not there, then the label that is.
        targets: [
          { kind: 'placeholder', value: 'Número de documento' },
          { kind: 'label', value: 'Número de documento' },
        ],
        value: { kind: 'template', text: '{{documento}}' },
        expect: 'Número de documento',
        landmarks: ['Certificado de antecedentes'],
      },
      {
        action: 'click',
        label: 'Generar el certificado',
        targets: [{ kind: 'role', value: 'button', name: 'Generar certificado' }],
        expect: 'Certificado generado',
        landmarks: ['Certificado de antecedentes'],
      },
      {
        action: 'extract',
        label: 'Leer el estado del certificado',
        // Pointing at the answer it saw. Correct on the day, wrong on the next
        // document -- and the only thing that can fix it is the DOM.
        targets: [{ kind: 'text', value: 'CON ANTECEDENTES' }],
        extractAs: 'estado',
        landmarks: ['Certificado generado'],
      },
    ],
  }),

  /**
   * The same errand taught with the door in the picture. The two password
   * fields come back as `secret`, which is the shape the extractor already
   * produces and the shape `unlockForRun` fills in at run time.
   */
  'acceso-grabado': (portal) => {
    const base = HYPOTHESES.acceso?.(portal) as Proposal;
    return {
      ...base,
      name: 'Certificado de antecedentes con ingreso',
      startUrl: `${portal}/entrar`,
      steps: [
        {
          action: 'goto',
          label: 'Abrir el ingreso al portal',
          targets: [],
          url: `${portal}/entrar`,
          landmarks: ['Ingreso al portal'],
        },
        {
          action: 'fill',
          label: 'Escribir el usuario',
          targets: [{ kind: 'label', value: 'Usuario' }],
          value: { kind: 'secret', field: 'usuario' },
          landmarks: ['Ingreso al portal'],
        },
        {
          action: 'fill',
          label: 'Escribir la contraseña',
          targets: [{ kind: 'label', value: 'Contraseña' }],
          value: { kind: 'secret', field: 'clave' },
          landmarks: ['Ingreso al portal'],
        },
        {
          action: 'click',
          label: 'Ingresar',
          targets: [{ kind: 'role', value: 'button', name: 'Ingresar' }],
          expect: 'Panel de servicios',
          landmarks: ['Ingreso al portal'],
        },
        ...base.steps.slice(1),
      ],
    };
  },

  formulario: (portal) => ({
    name: 'Radicar una novedad',
    description: 'Radica una novedad de cambio de dirección.',
    startUrl: `${portal}/novedad`,
    effect: 'write',
    variables: [
      { name: 'nombre', label: 'Nombre completo', example: 'María Fernanda Osorio', required: true },
      { name: 'documento', label: 'Número de documento', example: '52884109', required: true },
      { name: 'correo', label: 'Correo electrónico', example: 'mfosorio@acme.co', required: true },
      { name: 'telefono', label: 'Teléfono', example: '3105557788', required: true },
      { name: 'descripcion', label: 'Descripción', example: 'Traslado de la sede', required: true },
    ],
    notes: [],
    steps: [
      {
        action: 'goto',
        label: 'Abrir el formulario de novedades',
        targets: [],
        url: `${portal}/novedad`,
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'fill',
        label: 'Escribir el nombre completo',
        targets: [{ kind: 'label', value: 'Nombre completo' }],
        value: { kind: 'template', text: '{{nombre}}' },
        // An `expect` that will never come true: what was typed goes into the
        // field's VALUE and never becomes text on the page. The live model
        // produced exactly this on this exact step, and it is not an unusual
        // mistake -- "the name now appears in the field" is what the picture
        // shows and what a reader of pictures writes down.
        expect: 'María Fernanda Osorio',
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'fill',
        label: 'Escribir el número de documento',
        targets: [{ kind: 'label', value: 'Número de documento' }],
        value: { kind: 'template', text: '{{documento}}' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'fill',
        label: 'Escribir el correo',
        targets: [
          { kind: 'label', value: 'Correo' },
          { kind: 'label', value: 'Correo electrónico' },
        ],
        value: { kind: 'template', text: '{{correo}}' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'fill',
        label: 'Escribir el teléfono',
        targets: [
          { kind: 'label', value: 'Teléfono' },
          { kind: 'label', value: 'Teléfono de contacto' },
        ],
        value: { kind: 'template', text: '{{telefono}}' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'select',
        label: 'Elegir el departamento',
        targets: [{ kind: 'label', value: 'Departamento' }],
        value: { kind: 'literal', text: 'Antioquia' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'select',
        label: 'Elegir la ciudad',
        targets: [{ kind: 'label', value: 'Ciudad' }],
        value: { kind: 'literal', text: 'Envigado' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'select',
        label: 'Elegir el tipo de novedad',
        targets: [{ kind: 'label', value: 'Tipo de novedad' }],
        value: { kind: 'literal', text: 'Cambio de dirección' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'fill',
        label: 'Escribir la descripción',
        targets: [
          { kind: 'label', value: 'Descripción' },
          { kind: 'label', value: 'Descripción de la novedad' },
        ],
        value: { kind: 'template', text: '{{descripcion}}' },
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'check',
        label: 'Autorizar el tratamiento de datos',
        targets: [{ kind: 'label', value: 'Autorizo el tratamiento de mis datos personales' }],
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'click',
        label: 'Radicar la novedad',
        targets: [{ kind: 'role', value: 'button', name: 'Radicar novedad' }],
        expect: 'Novedad radicada',
        landmarks: ['Registro de novedad'],
      },
      {
        action: 'extract',
        label: 'Leer el número de radicado',
        targets: [{ kind: 'text', value: 'NV-2026-00742' }],
        extractAs: 'radicado',
        landmarks: ['Novedad radicada'],
      },
    ],
  }),

  tabla: (portal) => ({
    name: 'Estado de cartera de una factura',
    description: 'Busca las facturas de un NIT y lee el estado de una de ellas.',
    startUrl: `${portal}/facturas`,
    effect: 'read',
    variables: [{ name: 'nit', label: 'Número de NIT', example: '901348271', required: true }],
    notes: [],
    steps: [
      {
        action: 'goto',
        label: 'Abrir la consulta de facturación',
        targets: [],
        url: `${portal}/facturas`,
        landmarks: ['Consulta de facturación'],
      },
      {
        action: 'fill',
        label: 'Escribir el NIT',
        targets: [{ kind: 'label', value: 'Número de NIT' }],
        value: { kind: 'template', text: '{{nit}}' },
        expect: 'Número de NIT',
        landmarks: ['Consulta de facturación'],
      },
      {
        action: 'click',
        label: 'Buscar',
        targets: [{ kind: 'role', value: 'button', name: 'Buscar' }],
        expect: 'Facturas encontradas',
        landmarks: ['Consulta de facturación'],
      },
      {
        action: 'click',
        label: 'Abrir el detalle de la factura F-00312',
        // Five links read "Ver detalle" and a photograph cannot tell them apart:
        // what distinguishes them is an aria-label, which is not rendered. This
        // is the case where the picture has genuinely run out of information.
        targets: [
          { kind: 'text', value: 'Ver detalle' },
          { kind: 'role', value: 'link', name: 'Ver detalle' },
        ],
        expect: 'Detalle de la factura',
        landmarks: ['Facturas encontradas'],
      },
      {
        action: 'extract',
        label: 'Leer el estado de cartera',
        targets: [{ kind: 'text', value: 'EN MORA' }],
        extractAs: 'estado',
        landmarks: ['Detalle de la factura'],
      },
    ],
  }),
};
