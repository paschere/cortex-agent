export const LAUNCH_GROUPS = [
  'Tu empresa',
  'Información y equipo',
  'Cómo trabaja Cortex',
  'Primera misión',
] as const;
export type LaunchStep = {
  id: string;
  group: (typeof LAUNCH_GROUPS)[number];
  title: string;
  description: string;
  evidence: string;
  state: 'ready' | 'pending' | 'unknown';
  required: boolean;
  adminOnly?: boolean;
  action: { label: string; href: string };
  alternatives: { label: string; href: string }[];
  checklist: string[];
};
export type LaunchEvidence = {
  facts: number | null;
  configured: boolean | null;
  owner: boolean | null;
  sources: number | null;
  knowledge: number | null;
  people: number | null;
  goals: number | null;
  manuals: number | null;
  browserProfiles: number | null;
  browserConfigured: boolean;
  mandates: number | null;
  routines: number | null;
  verified: number | null;
};
const countState = (n: number | null): LaunchStep['state'] =>
  n === null ? 'unknown' : n > 0 ? 'ready' : 'pending';
const countCopy = (n: number | null, noun: string) =>
  n === null ? 'No se pudo consultar esta fuente. Reintenta la comprobación.' : `${n} ${noun}`;
export function buildLaunchPlan(e: LaunchEvidence): LaunchStep[] {
  const context =
    (e.sources ?? 0) > 0 || (e.knowledge ?? 0) > 0
      ? 1
      : e.sources === null || e.knowledge === null
        ? null
        : 0;
  return [
    {
      id: 'company',
      group: 'Tu empresa',
      title: 'Qué hace tu empresa',
      description: 'Dale a Cortex el contexto de tu negocio, sus productos y su forma de trabajar.',
      evidence: countCopy(
        e.facts,
        'datos en la ficha de empresa. Revísalos antes de darlos por vigentes.',
      ),
      state: countState(e.facts),
      required: true,
      adminOnly: true,
      action: { label: 'Completar ficha de empresa', href: '/company' },
      alternatives: [{ label: 'Contarlo en una conversación', href: '/onboarding/entrevista' }],
      checklist: [
        'Actividad, productos o servicios.',
        'Clientes y forma de operar.',
        'Reglas y datos que Cortex debe conocer.',
      ],
    },
    {
      id: 'scope',
      group: 'Tu empresa',
      title: 'El encargo de Cortex',
      description:
        'Cuenta todo junto o dicta. Cortex organiza alcance, prioridades y criterios de éxito en un borrador revisable.',
      evidence:
        e.configured === null
          ? 'No se pudo leer el encargo.'
          : e.configured
            ? 'Hay un encargo guardado. Puedes revisarlo o ampliarlo.'
            : 'El encargo todavía utiliza los valores iniciales.',
      state: e.configured === null ? 'unknown' : e.configured ? 'ready' : 'pending',
      required: true,
      adminOnly: true,
      action: { label: 'Preparar el encargo', href: '/management?tab=settings' },
      alternatives: [],
      checklist: [
        'Qué quieres que gestione y qué queda fuera.',
        'Qué es prioritario ahora.',
        'Cómo comprobarás que el trabajo sirvió.',
      ],
    },
    {
      id: 'context',
      group: 'Información y equipo',
      title: 'Fuentes y conocimiento',
      description:
        'Elige qué consultar y qué conservar. No necesitas conectar todas tus herramientas para empezar.',
      evidence: `${countCopy(e.sources, 'conexiones registradas')}. ${countCopy(e.knowledge, 'documentos en el cerebro')}. La existencia no garantiza sincronización ni vigencia.`,
      state: countState(context),
      required: true,
      action: { label: 'Traer datos al Feed', href: '/feed' },
      alternatives: [
        { label: 'Conectar herramientas', href: '/integrations' },
        { label: 'Preparar las fuentes financieras', href: '/finance' },
        { label: 'Guardar conocimiento permanente', href: '/kb' },
      ],
      checklist: [
        'Feed: archivos y enlaces para consultas puntuales, privados por defecto.',
        'Cerebro: conocimiento que decides guardar explícitamente.',
        'Integraciones: revisa permisos y estado de sincronización.',
      ],
    },
    {
      id: 'owner',
      group: 'Información y equipo',
      title: 'Quién decide y quién responde',
      description: 'Define quién recibe un bloqueo y prepara la participación de tu equipo.',
      evidence: `${countCopy(e.people, 'personas en la empresa')}. ${e.owner === null ? 'No se pudo comprobar el responsable.' : e.owner ? 'Responsable de escalamiento definido.' : 'Falta una persona para escalar bloqueos.'}`,
      state: e.owner === null ? 'unknown' : e.owner ? 'ready' : 'pending',
      required: true,
      adminOnly: true,
      action: { label: 'Definir responsable', href: '/management?tab=settings' },
      alternatives: [
        { label: 'Personas y accesos', href: '/admin/users' },
        { label: 'Equipos', href: '/admin/teams' },
      ],
      checklist: [
        'Elige a quién escalar si algo no avanza.',
        'Cada asunto tendrá su propio responsable.',
        'Invita solo a quienes participarán; puedes empezar tú solo.',
      ],
    },
    {
      id: 'goals',
      group: 'Cómo trabaja Cortex',
      title: 'Qué resultado vamos a medir',
      description: 'Conecta el encargo con una meta que tenga fuente, objetivo y período.',
      evidence: countCopy(
        e.goals,
        'metas activas. Una meta creada todavía necesita lecturas para evaluar resultados.',
      ),
      state: countState(e.goals),
      required: true,
      adminOnly: true,
      action: { label: 'Preparar una meta', href: '/goals' },
      alternatives: [],
      checklist: [
        'Selecciona una medición disponible para tu empresa.',
        'Acuerda objetivo y período.',
        'Revisa su fuente y método de cálculo.',
      ],
    },
    {
      id: 'manual',
      group: 'Cómo trabaja Cortex',
      title: 'El primer proceso',
      description:
        'Explica el recorrido completo: Cortex propone cómo separar pasos, excepciones y evidencia.',
      evidence: countCopy(
        e.manuals,
        'manuales guardados. Un manual no ejecuta acciones ni demuestra que el proceso fue probado.',
      ),
      state: countState(e.manuals),
      required: true,
      adminOnly: true,
      action: { label: 'Contar o dictar un proceso', href: '/management?tab=processes' },
      alternatives: [{ label: 'Revisar flujos', href: '/pipelines' }],
      checklist: [
        'Qué dispara el proceso y qué datos necesita.',
        'Pasos, responsables y situaciones excepcionales.',
        'Qué evidencia demuestra que terminó bien.',
      ],
    },
    {
      id: 'browser',
      group: 'Cómo trabaja Cortex',
      title: 'Trámites en el navegador',
      description:
        'Si el proceso pasa por portales, enséñalo dentro del navegador de Cortex, incluso entre varias páginas.',
      evidence: !e.browserConfigured
        ? 'El servicio de navegador no está configurado en este entorno.'
        : `${countCopy(e.browserProfiles, 'perfiles tuyos o compartidos disponibles')}. La conexión y el portal se prueban al abrir una sesión.`,
      state: !e.browserConfigured ? 'pending' : countState(e.browserProfiles),
      required: false,
      action: { label: 'Preparar mi navegador', href: '/browser' },
      alternatives: [],
      checklist: [
        'Crea un perfil personal y decide si lo compartes.',
        'Navega, selecciona, copia y explica el origen de los datos.',
        'Revisa lo aprendido y prueba el trámite antes de repetirlo.',
      ],
    },
    {
      id: 'authority',
      group: 'Cómo trabaja Cortex',
      title: 'Hasta dónde puede actuar',
      description:
        'Revisa qué requiere aprobación y qué acciones, si las hay, delegas expresamente.',
      evidence:
        e.mandates === null
          ? 'No se pudieron consultar los mandatos.'
          : e.mandates === 0
            ? 'No hay mandatos vigentes. Se mantienen los controles de aprobación de cada herramienta.'
            : `${e.mandates} mandatos vigentes. Revisa su alcance, límites y vencimiento.`,
      state: e.mandates === null ? 'unknown' : 'ready',
      required: false,
      adminOnly: true,
      action: { label: 'Revisar permisos y mandatos', href: '/admin/mandates' },
      alternatives: [{ label: 'Decisiones pendientes', href: '/approvals' }],
      checklist: [
        'Conservar las aprobaciones es una opción válida.',
        'Delegar exige definir acciones, límites y vigencia.',
        'Un manual o un dato compartido nunca concede autoridad.',
      ],
    },
    {
      id: 'routine',
      group: 'Cómo trabaja Cortex',
      title: 'Cuándo debe dar seguimiento',
      description:
        'Prepara el parte diario o una rutina concreta. La fecha de revisión de un asunto no programa una ejecución.',
      evidence: countCopy(
        e.routines,
        'rutinas activas tuyas o de la empresa. Revisa próximas ejecuciones y errores.',
      ),
      state: countState(e.routines),
      required: false,
      action: { label: 'Revisar rutinas', href: '/schedules' },
      alternatives: [{ label: 'Activar parte desde Gerencia', href: '/management' }],
      checklist: [
        'Define qué revisar, cuándo y para quién.',
        'Confirma la rutina antes de esperar avisos.',
        'Comprueba una ejecución real y su resultado.',
      ],
    },
    {
      id: 'mission',
      group: 'Primera misión',
      title: 'Cerrar el primer encargo',
      description:
        'Prueba el ciclo completo con un asunto real y acotado. No basta con que Cortex haya respondido.',
      evidence: countCopy(e.verified, 'asuntos verificados con revisión humana'),
      state: countState(e.verified),
      required: true,
      action: { label: 'Preparar la primera misión', href: '/management/mission' },
      alternatives: [
        {
          label: 'Acordar una operación de 30 días',
          href: '/management/operation',
        },
        {
          label: 'Planearla con Cortex',
          href: '/chat?prompt=Ay%C3%BAdame%20a%20preparar%20la%20primera%20misi%C3%B3n%20de%20mi%20empresa.%20Revisa%20el%20contexto%20existente%20y%20prop%C3%B3n%20un%20asunto%20acotado%20con%20responsable%2C%20fecha%20y%20evidencia%20de%20cierre.',
        },
      ],
      checklist: [
        'Define resultado, responsable, fecha y próximo paso.',
        'Revisa las propuestas y autoriza las acciones que correspondan.',
        'Comprueba el resultado en su fuente y registra la revisión humana.',
      ],
    },
  ];
}
export function launchProgress(steps: LaunchStep[]) {
  const required = steps.filter((s) => s.required);
  return {
    complete: required.length > 0 && required.every((s) => s.state === 'ready'),
    ready: required.filter((s) => s.state === 'ready').length,
    total: required.length,
    unknown: steps.filter((s) => s.state === 'unknown').length,
    next: required.find((s) => s.state !== 'ready')?.id ?? 'mission',
  };
}
