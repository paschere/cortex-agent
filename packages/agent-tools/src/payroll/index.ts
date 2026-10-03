// Side-effect imports register each tool with the registry at module load.
import './team-overview';
import './team-assignments';
import './employee-profile';
import './expenses-report';
import './payroll-stats';
import './client-report';
import './cost-projection';
// La nómina que se liquida en Cortex (0194).
import './local-tools';

export { payrollTeamOverview } from './team-overview';
export { payrollTeamAssignments } from './team-assignments';
export { payrollEmployeeProfile } from './employee-profile';
export { payrollExpensesReport } from './expenses-report';
export { payrollStats } from './payroll-stats';
export { payrollClientReport } from './client-report';
export { payrollCostProjection } from './cost-projection';

export { COMP_SENSITIVITY_NOTE } from './sensitive';

export {
  payrollFetch,
  fetchTeamOverview,
  fetchTeamAssignments,
  fetchEmployeeProfile,
  fetchExpensesReport,
  fetchPayrollStats,
} from './client';
export type {
  TeamOverview,
  ClientCount,
  DivisionCount,
  CurrencyCount,
  TeamAssignments,
  TeamAssignmentMember,
  EmployeeProfile,
  ExpensesReport,
  PayrollStats,
} from './client';

// --- La nómina propia, liquidada en Cortex (migración 0194) -----------------
export {
  ARL_RATES,
  MissingPayrollParamsError,
  PAYROLL_PARAMS,
  RATES as PAYROLL_RATES,
  fspRate,
  paramsFor as payrollParamsFor,
  supportedPayrollYears,
} from './co/params';
export type { PayrollParams } from './co/params';
export {
  AMOUNT_NOVELTIES,
  CONTRACT_LABEL as PAYROLL_CONTRACT_LABEL,
  CONTRACT_TYPES as PAYROLL_CONTRACT_TYPES,
  DAY_NOVELTIES,
  HOUR_NOVELTIES,
  NOVELTY_KINDS,
  NOVELTY_LABEL,
  cop as payrollMoney,
  liquidate as liquidatePayroll,
  retencionProcedimiento1,
  sumLiquidations,
} from './co/engine';
export type {
  CompanyForPayroll,
  ContractType as PayrollContractType,
  EmployeeForPayroll,
  LineGroup,
  Liquidation,
  Novelty,
  NoveltyKind,
  PayLine,
  PeriodForPayroll,
} from './co/engine';
export {
  businessDaysBetween as payrollBusinessDaysBetween,
  days360,
  isPayrollBusinessDay,
  periodsOfMonth,
  vacationEnd,
} from './co/dates';
export {
  LEAVE_KINDS,
  LEAVE_LABEL,
  LEAVE_NEEDS_EVIDENCE,
  VACATION_DAYS_PER_YEAR,
  checkLeaveRequest,
  leaveDays,
  vacationBalance,
} from './co/leave';
export type { LeaveKind, VacationBalance } from './co/leave';
export {
  TERMINATION_LABEL,
  TERMINATION_REASONS,
  liquidateTermination,
} from './co/termination';
export type { TerminationInput, TerminationReason, TerminationResult } from './co/termination';
export {
  NE_GUIDE,
  PAYMENT_GUIDE,
  PILA_GUIDE,
  electronicPayrollRows,
  paymentRows,
  pilaRows,
  toCsv as payrollCsv,
} from './co/exports';
export type { EmployeeForExport } from './co/exports';
export {
  DEFAULT_PAYROLL_SETTINGS,
  DOCUMENT_TYPES as PAYROLL_DOCUMENT_TYPES,
  LEAVE_STATUSES,
  LEAVE_STATUS_LABEL,
  PERIOD_STATUSES as PAYROLL_PERIOD_STATUSES,
  PERIOD_STATUS_LABEL as PAYROLL_PERIOD_STATUS_LABEL,
  employeeInputSchema,
  last4 as accountLast4,
  leaveInputSchema,
  noveltyInputSchema,
  periodLabel as payrollPeriodLabel,
} from './shape';
export type {
  Employee as PayrollEmployee,
  EmployeeInput as PayrollEmployeeInput,
  LeaveInput,
  LeaveRequest,
  LeaveStatus,
  NoveltyInput,
  NoveltyRow,
  PayrollPeriod,
  PayrollSettings,
  PeriodStatus as PayrollPeriodStatus,
  PeriodTotals as PayrollPeriodTotals,
} from './shape';
export {
  PAYROLL_COMMITMENT_SYSTEM,
  PAYROLL_LEDGER_SYSTEM,
  addNovelty,
  approvePeriod as approvePayrollPeriod,
  canDecideLeave,
  cancelLeave,
  currentPeriodFor as currentPayrollPeriod,
  decideLeave,
  ensurePeriod as ensurePayrollPeriod,
  findEmployee as findPayrollEmployee,
  getEmployee as getPayrollEmployee,
  getPeriod as getPayrollPeriod,
  liquidatePeriod as liquidatePayrollPeriod,
  listEmployees as listPayrollEmployees,
  listLeaveRequests,
  listNovelties as listPayrollNovelties,
  listPayslips,
  listPeriods as listPayrollPeriods,
  loadPeriodLiquidations,
  markPeriodPaid as markPayrollPeriodPaid,
  payrollAccess,
  periodLedgerDrafts as payrollLedgerDrafts,
  pilaDueFor,
  readPayrollSettings,
  requestLeave,
  retireEmployee,
  saveEmployee as savePayrollEmployee,
  savePayrollSettings,
  socialSecurityTotal,
  vacationBalanceFor,
  voidNovelty as voidPayrollNovelty,
  voidPeriod as voidPayrollPeriod,
} from './store';
export type { LiquidationResult, PayrollAccess, Payslip } from './store';
export { collectNomina, loadPayrollSnapshot } from './autopilot';
export type { SnapshotPayroll } from './autopilot';
export {
  payrollApprovePeriod,
  payrollLeaveDecide,
  payrollLeaveRequest,
  payrollLeaveStatus,
  payrollPayslip,
  payrollPeriodSummary,
  payrollRegisterNovelty,
} from './local-tools';
