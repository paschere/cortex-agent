export type ReadinessStep = {
  id: string;
  title: string;
  detail: string;
  href: string;
  state: 'ready' | 'pending' | 'unknown';
};
export function managementReadiness(input: {
  configured: boolean | null;
  owner: boolean | null;
  manuals: number | null;
  goals: number | null;
  sources: boolean;
  knowledge: boolean;
  verified: number | null;
}): ReadinessStep[] {
  const state = (value: boolean | null) =>
    value === null ? ('unknown' as const) : value ? ('ready' as const) : ('pending' as const);
  return [
    {
      id: 'scope',
      title: 'Un encargo claro',
      detail: 'Alcance, prioridades y cómo evaluar el trabajo.',
      href: '/management?tab=settings',
      state: state(input.configured),
    },
    {
      id: 'context',
      title: 'Información para decidir',
      detail:
        'Conecta una fuente o guarda conocimiento. El Feed también permite consultas temporales.',
      href: '/feed',
      state: state(input.sources || input.knowledge),
    },
    {
      id: 'owner',
      title: 'Una persona que decide',
      detail: 'Define a quién escalar cuando algo se bloquee.',
      href: '/management?tab=settings',
      state: state(input.owner),
    },
    {
      id: 'goals',
      title: 'Resultados medibles',
      detail: 'Una meta con fuente, objetivo y período de medición.',
      href: '/goals',
      state: state(input.goals === null ? null : input.goals > 0),
    },
    {
      id: 'process',
      title: 'Un primer proceso',
      detail: 'Cuenta el proceso completo, revisa sus pasos y su evidencia de éxito.',
      href: '/management?tab=processes',
      state: state(input.manuals === null ? null : input.manuals > 0),
    },
    {
      id: 'proof',
      title: 'Un resultado comprobado',
      detail: 'Lleva un asunto hasta el cierre con evidencia y revisión humana.',
      href: '/management',
      state: state(input.verified === null ? null : input.verified > 0),
    },
  ];
}
