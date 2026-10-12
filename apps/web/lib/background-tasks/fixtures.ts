import type { TaskBanner } from './banner';
import type { TaskFile } from './files';

/**
 * Datos de mentira para las pantallas de muestra (/v/tareas-showcase y
 * /v/chat-showcase?archivos=1) y para las pruebas. Nada de esto toca la base.
 */

export const FIXTURE_FILES: TaskFile[] = [
  {
    id: 'presentation:t1',
    source: 'presentation',
    name: 'Presentación Transmar — junio.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    sizeBytes: 1_240_000,
    createdAt: '2026-10-11T15:42:00Z',
    href: '/api/files/presentation/t1',
    external: false,
    driveable: false,
  },
  {
    id: 'report:r1',
    source: 'report',
    name: 'Vencimientos de la flota — octubre',
    kind: 'html',
    mime: 'text/html',
    sizeBytes: null,
    createdAt: '2026-10-11T15:40:00Z',
    href: '/reports/r1',
    external: false,
    driveable: false,
  },
  {
    id: 'document:d1',
    source: 'document',
    name: 'Paz y salvo RUNT — placa ABC123.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    sizeBytes: 84_000,
    createdAt: '2026-10-11T15:36:00Z',
    href: '/api/files/blob/demo.demo',
    external: false,
    driveable: true,
  },
  {
    id: 'link:cartera',
    source: 'link',
    name: 'Cartera por edades.xlsx',
    kind: 'sheet',
    mime: null,
    sizeBytes: null,
    createdAt: '2026-10-11T15:31:00Z',
    href: 'https://files.example.com/cartera-por-edades.xlsx',
    external: true,
    driveable: false,
  },
  {
    id: 'link:csv',
    source: 'link',
    name: 'Facturas vencidas.csv',
    kind: 'csv',
    mime: null,
    sizeBytes: null,
    createdAt: '2026-10-11T15:30:00Z',
    href: '/api/files/blob/csv.demo',
    external: false,
    driveable: false,
  },
];

/** Hace `min` minutos: las tareas vivas de muestra siempre «empezaron hace un rato». */
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const base = {
  conversationId: 'demo',
  segment: 1,
  deadlineAt: null,
  result: null,
  error: null,
  approvals: [],
};

export const FIXTURE_TASKS: Array<
  TaskBanner & { userId: string; ownerName: string | null; queuedAt: string }
> = [
  {
    ...base,
    id: 't-working',
    title: 'Revisar la cartera vencida y preparar los correos de cobro',
    status: 'working',
    stepsCount: 14,
    startedAt: ago(4),
    finishedAt: null,
    userId: 'u1',
    ownerName: null,
    queuedAt: ago(5),
  },
  {
    ...base,
    id: 't-needs',
    title: 'Enviar el estado de cuenta a los 12 clientes con mora de más de 60 días',
    status: 'needs_you',
    stepsCount: 9,
    startedAt: ago(11),
    finishedAt: null,
    approvals: [
      {
        id: 'a1',
        toolId: 'gmail.send',
        summary: 'Enviar un correo a Frigoandes (cobranza@frigoandes.co) con su estado de cuenta',
      },
    ],
    userId: 'u1',
    ownerName: null,
    queuedAt: ago(12),
  },
  {
    ...base,
    id: 't-done',
    title: 'Armar el informe de vencimientos de la flota de octubre',
    status: 'done',
    stepsCount: 22,
    startedAt: '2026-10-11T13:00:00Z',
    finishedAt: '2026-10-11T13:07:41Z',
    result:
      'Listo. Hay **7 vencimientos** en los próximos 30 días (3 SOAT, 2 tecnomecánica, 2 pólizas). El informe quedó guardado y la presentación en PDF está en los archivos de la tarea.',
    userId: 'u2',
    ownerName: 'Daniela Ortiz',
    queuedAt: '2026-10-11T12:59:00Z',
  },
  {
    ...base,
    id: 't-failed',
    title: 'Bajar el extracto de Bancolombia y conciliarlo',
    status: 'failed',
    stepsCount: 5,
    startedAt: '2026-10-11T11:00:00Z',
    finishedAt: '2026-10-11T11:03:10Z',
    error: 'El portal del banco pidió un código de verificación y la tarea no puede pedirlo sola.',
    userId: 'u1',
    ownerName: null,
    queuedAt: '2026-10-11T10:59:00Z',
  },
  {
    ...base,
    id: 't-queued',
    title: 'Comparar las tarifas de los tres operadores de carga refrigerada',
    status: 'queued',
    stepsCount: 0,
    startedAt: null,
    finishedAt: null,
    userId: 'u3',
    ownerName: 'Andrés Pardo',
    queuedAt: ago(1),
  },
  {
    ...base,
    id: 't-cancelled',
    title: 'Resumir las 40 facturas de proveedores de septiembre',
    status: 'cancelled',
    stepsCount: 3,
    startedAt: '2026-10-10T09:00:00Z',
    finishedAt: '2026-10-10T09:01:20Z',
    userId: 'u1',
    ownerName: null,
    queuedAt: '2026-10-10T08:59:00Z',
  },
];
