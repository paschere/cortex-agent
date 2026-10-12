import type { MetricModel } from '@/components/charts/metric-types';
import type { StatusTone } from '@/lib/status-chip';
import type { ActivityRowView, OpsKpi } from './ops';
import type { KpiView, NarrativePart } from './shape';

/**
 * LO QUE PINTA «HOY», YA ARMADO. Todo serializable: el servidor lo arma
 * (`read.ts`), el escaparate lo inventa (`/v/hoy-showcase`) y los componentes
 * sólo lo dibujan.
 */

export interface TodoView {
  id: string;
  title: string;
  detail: string | null;
  badge: { label: string; tone: StatusTone } | null;
  /** Para un correo: a quién, asunto y texto. */
  preview: { to: string; subject: string; body: string } | null;
  /** Se puede decidir aquí (cosa del piloto con huella). */
  decide: { itemId: string; contentHash: string; approveLabel: string } | null;
  /** «Editar» o «Abrir»: a dónde ir a verlo completo. */
  href: string | null;
  hrefLabel: string;
  /** «espera hace 2 días». */
  ageLabel?: string | null;
  /** Qué tan delicado es decidirlo. */
  risk?: { label: string; tone: StatusTone } | null;
}

export interface DoneView {
  id: string;
  title: string;
  timeLabel: string | null;
  href: string | null;
}

export interface DuePartyView {
  name: string;
  amount: string;
  count: number;
  /** «41 días», «al día», «vence 20 oct». */
  status: string;
  late: boolean;
}

export interface HoyView {
  today: string;
  dateLabel: string;
  greeting: string;
  firstName: string;
  narrative: NarrativePart[];
  money: null | {
    currency: string;
    metrics: MetricModel[];
    kpis: KpiView[];
  };
  todos: TodoView[];
  /** Cuántas más hay que no caben aquí. */
  todosMore: number;
  todosMoreHref: string | null;
  canDecide: boolean;
  done: DoneView[];
  due: null | {
    total: string;
    overdue: string;
    parties: DuePartyView[];
    href: string;
  };
  /** La fila «Operación»; vacía si no hay de dónde sacarla. */
  ops?: OpsKpi[];
  /** Lo que hizo Cortex, para la tabla de abajo. */
  activity?: ActivityRowView[];
  closing: { text: string; href: string; hrefLabel: string } | null;
  /** El piloto automático, si el módulo está prendido. */
  panelHref: string | null;
}
