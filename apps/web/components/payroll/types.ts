/**
 * LAS FORMAS QUE PINTA /nomina (0194). Todo llega armado del servidor
 * (lib/payroll/view.ts): estos componentes no calculan nada de la nómina y
 * no importan `@cortex/agent-tools` (sólo tipos), para no arrastrar el
 * paquete del servidor al navegador.
 */

export type ActionResult = { ok: true; note: string } | { ok: false; error: string };

export interface PayLineView {
  code: string;
  group: 'devengado' | 'deduccion' | 'aporte_empleador' | 'provision';
  label: string;
  amount: number;
  explanation: string;
  estimate?: boolean;
}

export interface PayslipView {
  periodId: string;
  periodLabel: string;
  status: string;
  statusLabel: string;
  payDate: string;
  employeeName: string;
  devengado: number;
  deducciones: number;
  neto: number;
  aportes: number;
  provisiones: number;
  costoTotal: number;
  days: {
    contract: number;
    salary: number;
    worked: number;
    vacation: number;
    incapacity: number;
    paidLeave: number;
    unpaid: number;
  };
  ibc: number;
  lines: PayLineView[];
  warnings: string[];
  estimates: string[];
  paramsVersion: string;
}

export interface PeriodView {
  id: string;
  label: string;
  start: string;
  end: string;
  payDate: string;
  status: 'borrador' | 'liquidado' | 'aprobado' | 'pagado' | 'anulado';
  statusLabel: string;
  totals: {
    devengado: number;
    deducciones: number;
    neto: number;
    aportes: number;
    provisiones: number;
    costoTotal: number;
    employees: number;
    seguridadSocial?: number;
  };
  paramsVersion: string | null;
}

export interface EmployeeView {
  id: string;
  name: string;
  documentType: string;
  documentNumber: string;
  email: string | null;
  jobTitle: string | null;
  contractType: string;
  contractLabel: string;
  startDate: string;
  endDate: string | null;
  salary: number;
  integral: boolean;
  apprenticePhase: 'lectiva' | 'productiva' | null;
  arlClass: number;
  eps: string | null;
  afp: string | null;
  ccf: string | null;
  arl: string | null;
  cesantiasFund: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountLast4: string | null;
  costCenter: string | null;
  dependents: boolean;
  vacationOpeningDays: number;
  vacationOpeningAsOf: string | null;
  userId: string | null;
  status: 'activo' | 'retirado';
  vacationBalance: number | null;
}

export interface NoveltyView {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: string;
  kindLabel: string;
  from: string;
  to: string | null;
  hours: number | null;
  amount: number | null;
  note: string | null;
  source: string;
}

export interface LeaveView {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: string;
  kindLabel: string;
  start: string;
  end: string;
  businessDays: number;
  calendarDays: number;
  status: 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada';
  statusLabel: string;
  reason: string | null;
  decisionNote: string | null;
  canDecide: boolean;
  mine: boolean;
}

export interface Option {
  value: string;
  label: string;
}

export interface PayrollSettingsView {
  frequency: 'mensual' | 'quincenal';
  exonerated1141: boolean;
  saturdayIsWorkday: boolean;
  responsibleUserId: string | null;
  configured: boolean;
}

export interface PayrollOptions {
  noveltyKinds: Option[];
  hourKinds: string[];
  dayKinds: string[];
  amountKinds: string[];
  leaveKinds: Option[];
  contractTypes: Option[];
  terminationReasons: Option[];
  team: Option[];
}

export interface ExportLinks {
  pila: string;
  electronica: string;
  pagos: string;
}

export interface PayrollGuides {
  pila: string[];
  electronica: string[];
  pagos: string[];
  params: { version: string; sources: string; needsConfirmation: string[] };
}
