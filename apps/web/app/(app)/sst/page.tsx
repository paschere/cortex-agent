import { SstScreen } from '@/components/sst/SstScreen';
import type { ActivityView, IncidentView } from '@/components/sst/types';
import { PageHeader } from '@/components/ui/page-header';
import { loadTeam } from '@/lib/clients/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  INCIDENT_KIND_LABEL,
  SST_RATING_LABEL,
  bogotaToday,
  canManageSst,
  incidentAlerts,
  isCompanyManager,
  listPayrollEmployees,
  listSstActivities,
  listSstIncidents,
  listSstPlan,
  readSstSettings,
  sstComplianceFor,
  standardsGroup,
} from '@cortex/agent-tools';
import { ShieldCheck } from 'lucide-react';
import {
  ensurePlanAction,
  logActivityAction,
  reportIncidentAction,
  saveSstSettingsAction,
  updateIncidentAction,
  updateStandardAction,
} from './actions';

/**
 * /sst (0194): el Sistema de Gestión de Seguridad y Salud en el Trabajo.
 *
 * Quien gestiona el SG-SST (el responsable designado o quien administra) ve
 * y edita todo. Los demás ven el porcentaje de cumplimiento y lo programado,
 * y pueden reportar un accidente o incidente; el registro de accidentes y los
 * exámenes (con nombres) no se les muestran.
 */

export const dynamic = 'force-dynamic';

const TABS = ['estandares', 'actividades', 'incidentes', 'configuracion'] as const;
type Tab = (typeof TABS)[number];

export default async function SstPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab: Tab = TABS.includes(q.tab as Tab) ? (q.tab as Tab) : 'estandares';
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const year = Number(today.slice(0, 4));
  const [settings, canManage, canConfigure] = await Promise.all([
    readSstSettings(db),
    canManageSst(db, user.id),
    isCompanyManager(db, user.id),
  ]);
  const [plan, compliance, activities, incidents, employees, team] = await Promise.all([
    listSstPlan(db, year),
    sstComplianceFor(db, year),
    listSstActivities(db, { limit: 500 }),
    canManage ? listSstIncidents(db, { limit: 200 }) : Promise.resolve([]),
    listPayrollEmployees(db).catch(() => []),
    canConfigure ? loadTeam(db).catch(() => []) : Promise.resolve([]),
  ]);
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const activityViews: ActivityView[] = activities
    .filter((a) => canManage || a.kind !== 'examen_medico')
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      kindLabel: ACTIVITY_KIND_LABEL[a.kind],
      title: a.title,
      plannedDate: a.plannedDate,
      doneDate: a.doneDate,
      status: a.status,
      participants: a.participants,
      person: canManage && a.employeeId ? (names.get(a.employeeId) ?? null) : null,
      examType: a.examType,
      standardCode: a.standardCode,
      hasEvidence: Boolean(a.evidenceDocumentId || a.evidenceUrl),
      overdue: a.status === 'programada' && Boolean(a.plannedDate && a.plannedDate < today),
    }));
  const incidentViews: IncidentView[] = incidents.map((i) => ({
    id: i.id,
    kind: i.kind,
    kindLabel: INCIDENT_KIND_LABEL[i.kind],
    severity: i.severity,
    occurredOn: i.occurredOn,
    person: i.employeeId ? (names.get(i.employeeId) ?? null) : null,
    place: i.place,
    description: i.description,
    furatDue: i.furatDue,
    furatReportedOn: i.furatReportedOn,
    investigationDue: i.investigationDue,
    investigationDoneOn: i.investigationDoneOn,
    ministryDue: i.ministryDue,
    status: i.status,
    alerts: i.status === 'cerrado' ? [] : incidentAlerts(i, today),
  }));

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Seguridad y salud en el trabajo"
        subtitle="El SG-SST de la empresa: estándares mínimos con su evidencia, plan anual, actividades y accidentes con sus plazos. Cortex lleva el registro y avisa; el sistema lo firma el responsable con licencia."
        icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
      />
      <SstScreen
        tab={tab}
        today={today}
        year={year}
        group={standardsGroup(settings.workers, settings.maxRiskClass)}
        canManage={canManage}
        canConfigure={canConfigure}
        settings={settings}
        compliance={{ ...compliance, ratingLabel: SST_RATING_LABEL[compliance.rating] }}
        standards={plan.map((p) => ({
          id: p.id,
          code: p.code,
          title: p.title,
          cycle: p.cycle,
          weight: p.weight,
          status: p.status,
          justification: p.justification,
          evidenceDocumentId: p.evidenceDocumentId,
          evidenceUrl: p.evidenceUrl,
          dueDate: p.dueDate,
        }))}
        activities={activityViews}
        incidents={incidentViews}
        activityKinds={ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_KIND_LABEL[k] }))}
        people={employees.map((e) => ({ value: e.id, label: e.name }))}
        team={team.map((t) => ({ value: t.id, label: t.name }))}
        actions={{
          saveSettings: saveSstSettingsAction,
          ensurePlan: ensurePlanAction,
          updateStandard: updateStandardAction,
          logActivity: logActivityAction,
          reportIncident: reportIncidentAction,
          updateIncident: updateIncidentAction,
        }}
      />
    </div>
  );
}
