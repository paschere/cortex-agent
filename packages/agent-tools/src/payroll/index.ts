// Side-effect imports register each tool with the registry at module load.
import './team-overview';
import './team-assignments';
import './employee-profile';
import './expenses-report';
import './payroll-stats';

export { payrollTeamOverview } from './team-overview';
export { payrollTeamAssignments } from './team-assignments';
export { payrollEmployeeProfile } from './employee-profile';
export { payrollExpensesReport } from './expenses-report';
export { payrollStats } from './payroll-stats';

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
