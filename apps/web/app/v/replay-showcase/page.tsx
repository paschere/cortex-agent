import { ReplayView } from '@/components/replay/ReplayView';
import type { ReplaySnapshot } from '@/lib/task-share/shape';
import { notFound } from 'next/navigation';
import { ThemeSetter } from './ThemeSetter';

/**
 * LA REPETICIÓN COMPARTIDA (/r/<token>) CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 * Parámetros: `?modo=oscuro`, `?datos=1` (sin ocultar datos personales).
 */
export const dynamic = 'force-dynamic';

const shot = (label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue},35%,92%)"/><rect x="24" y="24" width="592" height="40" rx="8" fill="hsl(${hue},30%,80%)"/><text x="40" y="50" font-family="sans-serif" font-size="16" fill="#334">${label}</text><rect x="24" y="96" width="400" height="14" rx="4" fill="hsl(${hue},20%,75%)"/><rect x="24" y="124" width="540" height="14" rx="4" fill="hsl(${hue},20%,80%)"/><rect x="24" y="152" width="320" height="14" rx="4" fill="hsl(${hue},20%,80%)"/></svg>`,
  )}`;

function snapshot(personal: boolean): ReplaySnapshot {
  const mail = personal ? '[correo oculto]' : 'contabilidad@distribuciones-andina.co';
  return {
    version: 1,
    title: 'Concilia el extracto del banco de septiembre',
    request: `Concilia el extracto de septiembre con la contabilidad y avísale a ${mail} lo que no cuadre.`,
    status: 'done',
    startedAt: '2026-10-12T14:05:00Z',
    finishedAt: '2026-10-12T14:19:00Z',
    companyName: 'Distribuciones Andina',
    ownerName: 'Ana',
    plan: {
      title: 'Conciliación de septiembre',
      steps: [
        { label: 'Leer el extracto del banco', status: 'done' },
        {
          label: 'Cruzar con facturas y pagos en Siigo',
          status: 'done',
          note: '212 de 230 partidas cruzadas',
        },
        { label: 'Listar las partidas abiertas', status: 'done' },
        {
          label: 'Enviar el resumen a contabilidad',
          status: 'skipped',
          note: 'Esperaba el visto bueno de Ana',
        },
      ],
    },
    steps: [
      { id: '1', sentence: 'Leer un documento', status: 'ok', kind: 'tool', shot: null },
      { id: '2', sentence: 'Abrí bancolombia.com', status: 'ok', kind: 'browser', shot: 'p0' },
      {
        id: '3',
        sentence: 'Hice clic en “Movimientos”',
        status: 'ok',
        kind: 'browser',
        shot: 'p1',
      },
      {
        id: '4',
        sentence: 'Pidió una clave a la persona',
        status: 'ok',
        kind: 'browser',
        shot: null,
      },
      { id: '5', sentence: 'Siigo: consultar facturas', status: 'ok', kind: 'tool', shot: null },
      { id: '6', sentence: 'Usó una credencial protegida', status: 'ok', kind: 'tool', shot: null },
      {
        id: '7',
        sentence: 'Enviar un correo: esperó el visto bueno',
        status: 'waiting',
        kind: 'tool',
        shot: null,
      },
      {
        id: '8',
        sentence: 'No pude abrir un enlace de la DIAN',
        status: 'error',
        kind: 'browser',
        shot: null,
      },
    ],
    answer: `## Conciliación de septiembre\n\nCruzó **212 de 230** partidas. Quedaron **18 abiertas** por $4.182.300:\n\n| Fecha | Descripción | Valor |\n|---|---|---|\n| 03/09 | Transferencia sin soporte | $1.250.000 |\n| 17/09 | Comisión bancaria | $86.300 |\n\nEl resumen para ${mail} quedó como borrador, esperando tu visto bueno.`,
    hidePersonal: personal,
  };
}

export default async function ReplayShowcasePage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const dark = q.modo === 'oscuro';
  const personal = q.datos !== '1';
  return (
    <main className="cortex-workspace min-h-screen bg-canvas">
      <ThemeSetter dark={dark} />
      <span aria-hidden className="block h-1 bg-primary" />
      <ReplayView
        snapshot={snapshot(personal)}
        expiresAt="2026-10-19T14:19:00Z"
        shotUrl={(key) =>
          shot(key === 'p0' ? 'bancolombia.com' : 'Movimientos', key === 'p0' ? 210 : 150)
        }
      />
    </main>
  );
}
