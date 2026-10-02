'use client';

import { CommandMenuProvider } from '@/components/nav/CommandMenuContext';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { MobileTabBar } from '@/components/nav/MobileTabBar';
import { Sidebar } from '@/components/nav/Sidebar';
import { Topbar } from '@/components/nav/Topbar';
import { PanelProvider } from '@/components/panel/PanelHost';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead, ProgressRow, StatCard } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import { AlertTriangle, CheckCircle2, Clock, LayoutDashboard, Wallet } from 'lucide-react';

const ORG = {
  id: 'fixture',
  name: 'Transportes Andinos',
  slug: null,
  role: 'owner',
  kind: 'company',
} as const;
const ROLE = 'org_admin' as const;
const COUNTS = { approvals: 2, commitments: 1, actions: 0, errands: 3 };

/** Datos inventados. Ninguna cifra de aquí sale de una base de datos. */
export function Fixture() {
  return (
    <MobileSidebarProvider>
      <CommandMenuProvider role={ROLE}>
        <PanelProvider>
          <div className="cortex-workspace flex h-screen overflow-hidden bg-canvas">
            <Sidebar role={ROLE} counts={COUNTS} organization={ORG} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar email="mateo@example.com" />
              <main className="scroll-slim flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
                  <PageHeader
                    title="Buenos días, Mateo. ¿Qué resolvemos hoy?"
                    subtitle="Miércoles, 1 de octubre · lo que se movió mientras no estabas."
                    icon={<LayoutDashboard className="h-5 w-5" />}
                    actions={
                      <>
                        <Button variant="outline">Ver registro</Button>
                        <Button>Activar un proceso</Button>
                      </>
                    }
                  />

                  <div className="mb-6 flex flex-wrap gap-2">
                    {[
                      'Resumen de la semana',
                      '¿Qué vence en 7 días?',
                      'Arma una vista de mis ventas',
                    ].map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        className="rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>

                  <div className="mb-6 grid gap-5 md:grid-cols-3">
                    <StatCard
                      label="Plata en riesgo"
                      value="$ 42.700.000"
                      sub="7 facturas vencidas · 2 pasan de 60 días"
                      icon={<AlertTriangle className="h-4 w-4" />}
                      tone="amber"
                    />
                    <StatCard
                      label="Recuperado este mes"
                      value="$ 18.250.000"
                      sub="11 pagos conciliados"
                      icon={<Wallet className="h-4 w-4" />}
                      tone="emerald"
                    />
                    <StatCard
                      label="Te espera"
                      value="6"
                      sub="2 aprobaciones · 3 encargos · 1 vencimiento"
                      icon={<Clock className="h-4 w-4" />}
                      tone="primary"
                    />
                  </div>

                  <div className="mb-6 grid gap-5 lg:grid-cols-12">
                    <Panel className="lg:col-span-7">
                      <PanelHead
                        title="Tus procesos"
                        right={<a href="#procesos">+ Activar otro</a>}
                      />
                      <ul className="px-5 pb-3">
                        {[
                          ['Cartera que avisa sola', 'Último aviso: hoy 7:00', 'ok'],
                          ['Guías desde la carpeta del socio', 'Hace 4 minutos', 'ok'],
                          ['Estado de vuelos en cada guía', 'Falta la clave de la API', 'warn'],
                        ].map(([name, when, state]) => (
                          <li
                            key={name}
                            className="flex items-center gap-3 border-b border-border py-3.5 last:border-0"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-base font-bold text-ink">{name}</span>
                              <span className="block text-xs text-ink-faint">{when}</span>
                            </span>
                            <span
                              className={
                                state === 'ok'
                                  ? 'rounded-pill bg-emerald-soft px-3 py-1 text-xs font-bold text-emerald'
                                  : 'rounded-pill bg-amber-soft px-3 py-1 text-xs font-bold text-amber'
                              }
                            >
                              {state === 'ok' ? 'Funcionando' : 'Termina de configurar'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Panel>
                    <Card className="space-y-4 lg:col-span-5">
                      <p className="field-label">Formulario</p>
                      <Input placeholder="Pídele algo a Cortex…" />
                      <div className="flex flex-wrap gap-2">
                        <Button>Preguntar</Button>
                        <Button variant="outline">Más tarde</Button>
                        <Button variant="ghost">Cancelar</Button>
                        <Button variant="danger">Borrar</Button>
                        <Button disabled>Deshabilitado</Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Provenance source="SIMIT" readAt="04 ago 10:18" detail="sin multas" />
                        <span className="stamp stamp--seal">Vencido</span>
                        <span className="rounded-pill bg-rose-soft px-2.5 py-0.5 text-micro font-semibold text-rose">
                          Bloqueado
                        </span>
                        <span className="rounded-pill bg-sky-soft px-2.5 py-0.5 text-micro font-semibold text-sky">
                          Informativo
                        </span>
                      </div>
                      <ProgressRow label="Tu Cortex está listo" value={60} total={100} />
                      <ProgressRow label="Facturas leídas" value={412} total={520} tone="emerald" />
                    </Card>
                  </div>

                  <Panel className="overflow-hidden">
                    <PanelHead
                      icon={<CheckCircle2 className="h-4 w-4" />}
                      title="Cartera vencida"
                      right="Actualizado hoy 7:00"
                    />
                    <table className="mt-3 w-full text-left text-sm">
                      <thead className="border-y border-border bg-surface-2 text-xs text-ink-muted">
                        <tr>
                          <th className="px-5 py-2 font-semibold">Cliente</th>
                          <th className="px-5 py-2 font-semibold">Factura</th>
                          <th className="px-5 py-2 text-right font-semibold">Saldo</th>
                          <th className="px-5 py-2 text-right font-semibold">Días</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ['Nexa Logística', 'FE-4471', '$ 12.400.000', '64'],
                          ['Frutas del Valle', 'FE-4398', '$ 9.850.000', '41'],
                          ['Andes Cargo', 'FE-4402', '$ 7.120.000', '33'],
                        ].map(([who, inv, amount, days]) => (
                          <tr key={inv} className="border-b border-border last:border-0">
                            <td className="px-5 py-3 font-semibold text-ink">{who}</td>
                            <td className="tabular px-5 py-3 text-ink-muted">{inv}</td>
                            <td className="tabular px-5 py-3 text-right text-ink">{amount}</td>
                            <td className="tabular px-5 py-3 text-right text-rose">{days}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>
                </div>
              </main>
              <MobileTabBar organizationId={ORG.id} />
            </div>
          </div>
        </PanelProvider>
      </CommandMenuProvider>
    </MobileSidebarProvider>
  );
}
