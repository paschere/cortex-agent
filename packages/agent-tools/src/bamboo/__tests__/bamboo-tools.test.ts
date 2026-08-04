import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classify, decide } from '../../security/policy';
import type { ToolContext } from '../../types';
import { bambooCompensationHistory } from '../compensation-history';
import { bambooCompensationReport } from '../compensation-report';
import { bambooDescribeFields } from '../describe-fields';
import { bambooListDocuments } from '../documents';
import { bambooEmploymentHistory } from '../employment-history';
import { bambooGetEmployee } from '../get-employee';
import { bambooHeadcount } from '../headcount';
import { bambooListEmployees } from '../list-employees';
import { bambooOrgChart } from '../org-chart';
import { bambooRecentlyChanged } from '../recently-changed';
import { parseMoney } from '../shape';
import {
  bambooTimeOffBalance,
  bambooTimeOffRequests,
  bambooTimeOffTypes,
  bambooWhosOut,
} from '../time-off';
import {
  bambooEmployeeProjects,
  bambooTimesheetEntries,
  bambooTimesheetSummary,
} from '../time-tracking';

const fakeCtx = (): ToolContext =>
  ({
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    db: {} as never,
    integrations: {
      getAccessToken: async () => ({ token: 't', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    },
  }) as unknown as ToolContext;

const BASE = 'https://api.bamboohr.com/api/gateway.php/acme/v1';
const REPORTS = `${BASE}/reports/custom`;
const META_FIELDS = `${BASE}/meta/fields`;
const META_TABLES = `${BASE}/meta/tables`;
const META_TIME_OFF = `${BASE}/meta/time_off/types`;
const WHOS_OUT = `${BASE}/time_off/whos_out`;
const REQUESTS = `${BASE}/time_off/requests`;
const CHANGED = `${BASE}/employees/changed`;
const ENTRIES = `${BASE}/time_tracking/timesheet_entries`;
const TABLE = `${BASE}/employees/:id/tables/:table`;
const FILES = `${BASE}/employees/:id/files/view/`;
const CALCULATOR = `${BASE}/employees/:id/time_off/calculator`;
const PROJECTS = `${BASE}/time_tracking/employee/:id/projects`;

/**
 * Rows shaped exactly as this instance returns them, including the two quirks
 * that matter: money arrives as "4500.00 USD", and an employee with nothing on
 * file arrives as " USD" with a "0000-00-00" date.
 */
const ROWS = [
  {
    id: '174',
    displayName: 'Emmanuel Castro',
    workEmail: 'emmanuel.castro@example.com',
    jobTitle: 'Mid/Sr Java Developer',
    department: 'Click Call Sell',
    division: 'Tech',
    location: 'Mexico',
    status: 'Active',
    employmentHistoryStatus: 'Full-Time',
    hireDate: '2024-04-01',
    originalHireDate: '2019-08-26',
    terminationDate: '0000-00-00',
    reportsTo: 'Adriana Garcia Marquez',
    supervisorEmail: 'adriana.garcia@example.com',
    payRate: '4500.00 USD',
    payPeriod: 'Twice a month',
    payType: 'Salary',
    payFrequency: 'Twice a month',
    timeTrackingEnabled: '1',
    customBillRate: '7492.00 USD',
    customBillRateEffectiveDate: '2024-04-01',
    'customProject/Client': 'Click Call Sell',
    customManagerName: 'Michael Grigery',
    customManagerEmail: 'michael@clickcallsell.com',
    customInternalPod: 'ConnectOps',
    customAssignedCSM: 'Adriana Garcia Marquez',
    customAssignedTSP: 'Luis Perez',
  },
  {
    id: '633',
    displayName: 'Adriana Garcia Marquez',
    workEmail: 'adriana.garcia@example.com',
    jobTitle: 'Client Success Manager',
    department: 'Internal',
    division: 'Internal',
    location: 'Mexico',
    status: 'Active',
    employmentHistoryStatus: 'Full-Time',
    hireDate: '2021-02-01',
    originalHireDate: '0000-00-00',
    terminationDate: '0000-00-00',
    reportsTo: null,
    supervisorEmail: null,
    // No rate on file at all — BambooHR sends the currency suffix alone.
    payRate: ' USD',
    payPeriod: null,
    payType: null,
    payFrequency: null,
    timeTrackingEnabled: '0',
    customBillRate: ' USD',
    customBillRateEffectiveDate: '0000-00-00',
    'customProject/Client': null,
    customManagerName: null,
    customManagerEmail: null,
    customInternalPod: null,
    customAssignedCSM: null,
    customAssignedTSP: null,
  },
  {
    id: '113',
    displayName: 'Jazmin Montoya',
    workEmail: 'jazmin.montoya@example.com',
    jobTitle: 'Recruiter',
    department: 'Internal',
    division: 'Internal',
    location: 'Mexico',
    status: 'Inactive',
    employmentHistoryStatus: 'Terminated',
    hireDate: '2018-05-14',
    originalHireDate: '0000-00-00',
    terminationDate: '2023-11-30',
    reportsTo: 'Adriana Garcia Marquez',
    supervisorEmail: 'adriana.garcia@example.com',
    // Different currency from the bill rate — margin must NOT be computed.
    payRate: '45000.00 MXN',
    payPeriod: 'Twice a month',
    payType: 'Salary',
    payFrequency: 'Twice a month',
    timeTrackingEnabled: '0',
    customBillRate: '3000.00 USD',
    customBillRateEffectiveDate: '2022-01-01',
    'customProject/Client': null,
    customManagerName: null,
    customManagerEmail: null,
    customInternalPod: null,
    customAssignedCSM: null,
    customAssignedTSP: null,
  },
];

const server = setupServer(
  http.post(REPORTS, () => HttpResponse.json({ title: 'Report', fields: [], employees: ROWS })),
  http.get(META_FIELDS, () =>
    HttpResponse.json([
      { id: 19, name: 'Pay rate', type: 'currency', alias: 'payRate' },
      {
        id: '19.1',
        name: 'Pay rate - Currency code',
        type: 'text',
        alias: 'payRate',
      },
      { id: 4631, name: 'Bill Rate', type: 'currency' },
      { id: '4631.1', name: 'Bill Rate - Currency code', type: 'text' },
      { id: 4630, name: 'Bill Rate Effective Date', type: 'date' },
      { id: 4525, name: 'Bank Account Number', type: 'text' },
      { id: 3, name: 'Hire Date', type: 'date', alias: 'hireDate' },
    ]),
  ),
  http.get(META_TABLES, () =>
    HttpResponse.json([
      {
        alias: 'customBillRate1',
        fields: [
          { id: 4630, name: 'Bill Rate Effective Date' },
          { id: 4631, name: 'Bill Rate' },
        ],
      },
      { alias: 'jobInfo', fields: [{ id: 17, name: 'Job Title' }] },
    ]),
  ),
  http.get(META_TIME_OFF, () =>
    HttpResponse.json({
      timeOffTypes: [
        { id: '86', name: 'PTO', units: 'hours' },
        { id: '84', name: 'Sick', units: 'hours' },
      ],
    }),
  ),
  http.get(WHOS_OUT, () =>
    HttpResponse.json([
      {
        id: 1,
        type: 'timeOff',
        employeeId: 174,
        name: 'Emmanuel Castro',
        start: '2026-07-27',
        end: '2026-07-31',
      },
      {
        id: 2,
        type: 'holiday',
        name: 'Independence Day',
        start: '2026-09-16',
        end: '2026-09-16',
      },
    ]),
  ),
  http.get(REQUESTS, () =>
    HttpResponse.json([
      {
        id: '3631',
        employeeId: '174',
        name: 'Emmanuel Castro',
        start: '2026-07-27',
        end: '2026-07-31',
        created: '2026-07-20',
        status: { status: 'requested', lastChanged: '2026-07-20' },
        type: { name: 'PTO' },
        amount: { unit: 'hours', amount: '40' },
        notes: { employee: 'Family trip' },
      },
    ]),
  ),
  http.get(CHANGED, () =>
    HttpResponse.json({
      latest: '2026-07-28T16:23:00+00:00',
      employees: {
        '174': {
          id: '174',
          action: 'Updated',
          lastChanged: '2026-07-22T15:46:43+00:00',
        },
        '999': {
          id: '999',
          action: 'Deleted',
          lastChanged: '2026-07-25T10:00:00+00:00',
        },
      },
    }),
  ),
  http.get(ENTRIES, () =>
    HttpResponse.json([
      {
        id: 1,
        employeeId: 174,
        type: 'clock',
        date: '2026-07-01',
        hours: 4.5,
        note: null,
        approved: true,
        projectInfo: {
          project: { id: 11, name: 'Click Call Sell' },
          task: null,
        },
      },
      {
        id: 2,
        employeeId: 174,
        type: 'manual',
        date: '2026-07-02',
        hours: 3.25,
        note: 'Sprint planning',
        approved: false,
        projectInfo: {
          project: { id: 11, name: 'Click Call Sell' },
          task: { name: 'Meetings' },
        },
      },
    ]),
  ),
  http.get(TABLE, ({ params }) => {
    if (params.table === 'compensation') {
      return HttpResponse.json([
        {
          id: '1',
          startDate: '2024-04-01',
          rate: { currency: 'USD', value: '4000.00' },
          type: 'Salary',
          reason: 'Re-Hire',
          comment: null,
        },
        {
          id: '2',
          startDate: '2025-10-01',
          rate: { currency: 'USD', value: '4500.00' },
          type: 'Salary',
          reason: 'Salary Increase',
          comment: null,
        },
      ]);
    }
    if (params.table === 'customBillRate1') {
      return HttpResponse.json([
        {
          id: 551,
          customBillRateEffectiveDate: '2024-04-01',
          customBillRate: '6800.00 USD',
          customComment: 'Re-Hire',
        },
        {
          id: 1023,
          customBillRateEffectiveDate: '2025-10-01',
          customBillRate: '7492.00 USD',
          customComment: 'Salary Increase',
        },
      ]);
    }
    if (params.table === 'jobInfo') {
      return HttpResponse.json([
        {
          id: '1',
          date: '2024-04-01',
          location: 'Mexico',
          department: 'Conquernow',
          division: 'Tech',
          jobTitle: 'Mid/Sr Java Developer',
          reportsTo: 'Lucia Baumann',
        },
        {
          id: '2',
          date: '2025-11-24',
          location: 'Mexico',
          department: 'Click Call Sell',
          division: 'Tech',
          jobTitle: 'Mid/Sr Java Developer',
          reportsTo: 'Adriana Garcia Marquez',
        },
      ]);
    }
    if (params.table === 'employmentStatus') {
      return HttpResponse.json([
        {
          id: '1',
          date: '2019-08-26',
          employmentStatus: 'Full-Time',
          comment: 'New Hire',
          terminationReasonId: '',
        },
        {
          id: '2',
          date: '2022-03-25',
          employmentStatus: 'Terminated',
          comment: null,
          terminationReasonId: 'Project Ended',
          terminationTypeId: 'Termination (Involuntary)',
          terminationRehireId: 'Yes',
        },
      ]);
    }
    return HttpResponse.json([]);
  }),
  http.get(FILES, () =>
    HttpResponse.json({
      employee: { id: 174 },
      categories: [
        { id: 30, name: 'Exit Documents', files: [] },
        {
          id: 32,
          name: 'Payment Receipts 2026',
          files: [
            {
              id: 13063,
              name: 'Emmanuel Castro - 1 April to 15 April - 2026.pdf',
              originalFileName: 'payslip.pdf',
              size: 19508,
              dateCreated: '2026-04-22T13:16:30+0000',
              createdBy: 'Bruno Mazurok',
              shareWithEmployee: 'yes',
            },
          ],
        },
        {
          id: 12,
          name: 'Contracts',
          files: [
            {
              id: 900,
              name: 'Signed NDA.pdf',
              size: 4096,
              dateCreated: '2024-04-02T09:00:00+0000',
              createdBy: 'HR',
              shareWithEmployee: 'no',
            },
          ],
        },
      ],
    }),
  ),
  http.get(CALCULATOR, () =>
    HttpResponse.json([
      {
        timeOffType: '86',
        name: 'PTO',
        units: 'hours',
        balance: '69.76',
        end: '2026-12-31',
        policyType: 'accruing',
        usedYearToDate: '32.00',
      },
    ]),
  ),
  http.get(PROJECTS, () =>
    HttpResponse.json([{ id: 11, name: 'Click Call Sell', hasTasks: false }]),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  process.env.BAMBOOHR_API = 'test-key';
  process.env.BAMBOOHR_BASE_URL = BASE;
});
afterEach(() => {
  process.env.BAMBOOHR_API = '';
});

// ---------------------------------------------------------------------------

describe('BambooHR tools — not configured', () => {
  beforeEach(() => {
    process.env.BAMBOOHR_API = '';
  });

  it('the roster reports itself unconfigured instead of throwing', async () => {
    const out = await bambooListEmployees.handler({ status: 'active', limit: 50 }, fakeCtx());
    expect(out.configured).toBe(false);
    expect(out.employees).toEqual([]);
    expect(out.reason).toMatch(/not connected/i);
  });

  it('every tool fails soft with a sentence a non-technical person can read', async () => {
    const results = await Promise.all([
      bambooListEmployees.handler({ status: 'active', limit: 50 }, fakeCtx()),
      bambooGetEmployee.handler({ name: 'Emmanuel', includeCompensation: true }, fakeCtx()),
      bambooCompensationHistory.handler({ name: 'Emmanuel' }, fakeCtx()),
      bambooCompensationReport.handler(
        { status: 'active', onlyMissingBillRate: false, limit: 400 },
        fakeCtx(),
      ),
      bambooEmploymentHistory.handler({ name: 'Emmanuel' }, fakeCtx()),
      bambooOrgChart.handler({ name: 'Emmanuel', includeInactive: false }, fakeCtx()),
      bambooHeadcount.handler({ groupBy: 'division', status: 'active', limit: 30 }, fakeCtx()),
      bambooRecentlyChanged.handler({ sinceDays: 7, change: 'any', limit: 50 }, fakeCtx()),
      bambooWhosOut.handler({}, fakeCtx()),
      bambooTimeOffRequests.handler({ status: 'any', limit: 50 }, fakeCtx()),
      bambooTimeOffBalance.handler({ name: 'Emmanuel' }, fakeCtx()),
      bambooTimeOffTypes.handler({}, fakeCtx()),
      bambooTimesheetSummary.handler({ limit: 60 }, fakeCtx()),
      bambooTimesheetEntries.handler({ name: 'Emmanuel', limit: 100 }, fakeCtx()),
      bambooEmployeeProjects.handler({ name: 'Emmanuel' }, fakeCtx()),
      bambooListDocuments.handler({ name: 'Emmanuel', payslipsOnly: false, limit: 50 }, fakeCtx()),
      bambooDescribeFields.handler({ includeTables: true, limit: 80 }, fakeCtx()),
    ]);
    for (const out of results) {
      expect(out.configured).toBe(false);
      expect(out.reason).toBeTruthy();
      // No env var names, no status codes, no stack traces.
      expect(out.reason).not.toMatch(/BAMBOOHR_API|undefined|Error|401|500/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('money parsing — the "4500.00 USD" shape', () => {
  it('splits the amount from the currency and keeps a real number', () => {
    expect(parseMoney('4500.00 USD')).toEqual({
      amount: 4500,
      currency: 'USD',
      display: '4,500.00 USD',
    });
  });

  it('reads an empty rate as missing, not as zero', () => {
    // The payroll sync's split(' ')[0] yields "" here and writes a blank rate.
    // A missing rate has to stay visibly missing.
    for (const raw of [' USD', '', '   ', null, undefined]) {
      expect(parseMoney(raw).amount).toBeNull();
      expect(parseMoney(raw).display).toBeNull();
    }
  });

  it('reads the nested tabular shape as well as the flat string', () => {
    expect(parseMoney({ currency: 'USD', value: '5500.00' })).toEqual({
      amount: 5500,
      currency: 'USD',
      display: '5,500.00 USD',
    });
    expect(parseMoney({ currency: 'USD', value: '' }).amount).toBeNull();
  });

  it('handles thousands separators and other currencies', () => {
    expect(parseMoney('45,000.00 MXN')).toEqual({
      amount: 45000,
      currency: 'MXN',
      display: '45,000.00 MXN',
    });
  });

  it('refuses to invent a number out of prose', () => {
    expect(parseMoney('not a rate').amount).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('BambooHR tools — successful parses', () => {
  it('the roster projects the people and carries no rate anywhere', async () => {
    const out = await bambooListEmployees.handler({ status: 'active', limit: 50 }, fakeCtx());
    expect(out.configured).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.totalMatched).toBe(2);
    expect(out.employees[0]?.name).toBe('Emmanuel Castro');
    expect(out.employees[0]?.department).toBe('Click Call Sell');
    expect(out.employees[0]?.tenure).toBeTruthy();
    // An unset termination date is null, never the literal "0000-00-00".
    expect(out.employees[0]?.terminationDate).toBeNull();
    const json = JSON.stringify(out);
    expect(json).not.toContain('payRate');
    expect(json).not.toContain('4500');
    expect(json).not.toContain('7492');
    expect(out.source.provider).toBe('BambooHR');
  });

  it('the roster filters by client, division and status', async () => {
    const byClient = await bambooListEmployees.handler(
      { status: 'active', department: 'click call', limit: 50 },
      fakeCtx(),
    );
    expect(byClient.employees.map((e) => e.name)).toEqual(['Emmanuel Castro']);

    const inactive = await bambooListEmployees.handler(
      { status: 'inactive', limit: 50 },
      fakeCtx(),
    );
    expect(inactive.employees.map((e) => e.name)).toEqual(['Jazmin Montoya']);
  });

  it('the employee lookup keeps pay and bill rate apart and works out the margin', async () => {
    const out = await bambooGetEmployee.handler(
      { name: 'Emmanuel Castro', includeCompensation: true },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.compensation?.payRate.amount).toBe(4500);
    expect(out.compensation?.billRate.amount).toBe(7492);
    expect(out.compensation?.grossMargin.amount).toBe(2992);
    expect(out.compensation?.marginPercent).toBeCloseTo(39.9, 1);
    expect(out.placement?.clientManagerEmail).toBe('michael@clickcallsell.com');
    // The glossary travels with every answer that carries a rate.
    expect(out.guidance).toMatch(/what the company pays/i);
    expect(out.guidance).toMatch(/what the company charges/i);
    // Re-hire: tenure from the ORIGINAL hire date must be surfaced.
    expect(out.guidance).toMatch(/originally hired/i);
  });

  it('withholds compensation when it is not asked for', async () => {
    const out = await bambooGetEmployee.handler(
      { email: 'emmanuel.castro@example.com', includeCompensation: false },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.compensation).toBeNull();
    expect(JSON.stringify(out)).not.toContain('7492');
  });

  it('reports a missing bill rate as missing rather than falling back to pay', async () => {
    const out = await bambooGetEmployee.handler(
      { name: 'Adriana Garcia Marquez', includeCompensation: true },
      fakeCtx(),
    );
    expect(out.compensation?.billRate.amount).toBeNull();
    expect(out.compensation?.payRate.amount).toBeNull();
    expect(out.guidance).toMatch(/no bill rate recorded/i);
  });

  it('refuses to subtract across two currencies', async () => {
    const out = await bambooGetEmployee.handler(
      { name: 'Jazmin Montoya', includeCompensation: true },
      fakeCtx(),
    );
    expect(out.compensation?.payRate.currency).toBe('MXN');
    expect(out.compensation?.billRate.currency).toBe('USD');
    expect(out.compensation?.grossMargin.amount).toBeNull();
    expect(out.compensation?.marginPercent).toBeNull();
    expect(out.guidance).toMatch(/different currencies/i);
  });

  it('asks which person was meant instead of guessing between two matches', async () => {
    server.use(
      http.post(REPORTS, () =>
        HttpResponse.json({
          employees: [
            { ...ROWS[0], id: '1', displayName: 'Juan Perez' },
            { ...ROWS[0], id: '2', displayName: 'Juan Perez Diaz' },
          ],
        }),
      ),
    );
    // A partial name matching two active people must not resolve to whichever
    // row came back first — quoting the wrong person's salary is the failure
    // this costs a round-trip to avoid.
    const out = await bambooGetEmployee.handler(
      { name: 'Juan', includeCompensation: true },
      fakeCtx(),
    );
    expect(out.found).toBe(false);
    expect(out.compensation).toBeNull();
    expect(out.candidates.length).toBe(2);
    expect(out.reason).toMatch(/more than one person/i);
  });

  it('an exact full name beats a longer partial match', async () => {
    server.use(
      http.post(REPORTS, () =>
        HttpResponse.json({
          employees: [
            { ...ROWS[0], id: '1', displayName: 'Juan Perez' },
            { ...ROWS[0], id: '2', displayName: 'Juan Perez Diaz' },
          ],
        }),
      ),
    );
    const out = await bambooGetEmployee.handler(
      { name: 'Juan Perez', includeCompensation: false },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.employee?.name).toBe('Juan Perez');
  });

  it('prefers the person who still works here when a name collides', async () => {
    server.use(
      http.post(REPORTS, () =>
        HttpResponse.json({
          employees: [
            {
              ...ROWS[0],
              id: '1',
              displayName: 'Ana Ruiz',
              status: 'Inactive',
            },
            { ...ROWS[0], id: '2', displayName: 'Ana Ruiz', status: 'Active' },
          ],
        }),
      ),
    );
    const out = await bambooGetEmployee.handler(
      { name: 'Ana Ruiz', includeCompensation: false },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.employee?.status).toBe('Active');
  });

  it('matches an accented name typed without accents', async () => {
    server.use(
      http.post(REPORTS, () =>
        HttpResponse.json({
          employees: [{ ...ROWS[0], displayName: 'Mariana Pérez Dauzón' }],
        }),
      ),
    );
    const out = await bambooGetEmployee.handler(
      { name: 'Mariana Perez Dauzon', includeCompensation: false },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
  });

  it('the rate history interleaves pay and bill changes and finds the last raise', async () => {
    const out = await bambooCompensationHistory.handler({ name: 'Emmanuel Castro' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.changes).toHaveLength(4);
    expect(out.currentPayRate?.amount).toBe(4500);
    expect(out.currentBillRate?.amount).toBe(7492);
    expect(out.lastPayRaiseDate).toBe('2025-10-01');
    const raise = out.changes.find((c) => c.kind === 'pay' && c.effectiveDate === '2025-10-01');
    expect(raise?.changeFromPrevious.amount).toBe(500);
    expect(raise?.percentChange).toBeCloseTo(12.5, 1);
    expect(raise?.reason).toBe('Salary Increase');
  });

  it('the bulk compensation report totals per currency and counts the gaps', async () => {
    const out = await bambooCompensationReport.handler(
      { status: 'any', onlyMissingBillRate: false, limit: 400 },
      fakeCtx(),
    );
    expect(out.totalPeople).toBe(3);
    expect(out.peopleWithoutBillRate).toBe(1);
    const usd = out.totalsByCurrency.find((t) => t.currency === 'USD');
    // Only the one person whose pay and bill are both USD is summed. The
    // MXN-pay/USD-bill row must never be folded into a total.
    expect(usd?.people).toBe(1);
    expect(usd?.totalPay).toBe(4500);
    expect(usd?.totalBill).toBe(7492);
    expect(usd?.totalMargin).toBe(2992);
    expect(out.guidance).toMatch(/share it only with whoever asked/i);
  });

  it('the bulk report can list only the people missing a bill rate', async () => {
    const out = await bambooCompensationReport.handler(
      { status: 'any', onlyMissingBillRate: true, limit: 400 },
      fakeCtx(),
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.name).toBe('Adriana Garcia Marquez');
  });

  it('headcount returns counts and never a name or a rate', async () => {
    const out = await bambooHeadcount.handler(
      { groupBy: 'division', status: 'active', limit: 30 },
      fakeCtx(),
    );
    expect(out.total).toBe(2);
    expect(out.groups).toEqual(
      expect.arrayContaining([
        { label: 'Tech', count: 1 },
        { label: 'Internal', count: 1 },
      ]),
    );
    expect(out.byTenure.length).toBeGreaterThan(0);
    const json = JSON.stringify(out);
    expect(json).not.toContain('Emmanuel');
    expect(json).not.toContain('4500');
  });

  it('employment history reports what changed between job records', async () => {
    const out = await bambooEmploymentHistory.handler({ name: 'Emmanuel Castro' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.clientsWorkedWith).toEqual(['Conquernow', 'Click Call Sell']);
    expect(out.currentClientSince).toBe('2025-11-24');
    expect(out.jobChanges[1]?.whatChanged).toEqual(expect.arrayContaining(['client', 'manager']));
    expect(out.statusChanges[1]?.terminationReason).toBe('Project Ended');
    expect(JSON.stringify(out)).not.toContain('4500');
  });

  it('the org chart finds the manager and the direct reports', async () => {
    const out = await bambooOrgChart.handler(
      { name: 'Adriana Garcia Marquez', includeInactive: false },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.directReportCount).toBe(1);
    expect(out.directReports[0]?.name).toBe('Emmanuel Castro');

    const withInactive = await bambooOrgChart.handler(
      { name: 'Adriana Garcia Marquez', includeInactive: true },
      fakeCtx(),
    );
    expect(withInactive.directReportCount).toBe(2);
  });

  it('recently changed joins the delta feed to real names', async () => {
    const out = await bambooRecentlyChanged.handler(
      { sinceDays: 7, change: 'any', limit: 50 },
      fakeCtx(),
    );
    expect(out.totalChanged).toBe(2);
    expect(out.changes[0]?.changedAt).toBe('2026-07-25T10:00:00+00:00');
    expect(out.changes.find((c) => c.name === 'Emmanuel Castro')?.change).toBe('Updated');
    expect(out.guidance).toMatch(/does not say which field/i);
  });

  it("who's out separates people's leave from company holidays", async () => {
    const out = await bambooWhosOut.handler({ start: '2026-07-01', end: '2026-07-31' }, fakeCtx());
    expect(out.absences).toHaveLength(2);
    expect(out.peopleOut).toBe(1);
    expect(out.absences[0]?.days).toBe(5);
  });

  it('time-off requests surface what is still awaiting approval', async () => {
    const out = await bambooTimeOffRequests.handler(
      { start: '2026-07-01', end: '2026-07-31', status: 'any', limit: 50 },
      fakeCtx(),
    );
    expect(out.awaitingApproval).toBe(1);
    expect(out.requests[0]?.amount).toBe(40);
    expect(out.requests[0]?.unit).toBe('hours');
    expect(out.guidance).toMatch(/I only read/i);
  });

  it('time-off balances come back per policy', async () => {
    const out = await bambooTimeOffBalance.handler({ name: 'Emmanuel Castro' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.balances[0]).toEqual({
      policy: 'PTO',
      balance: 69.76,
      usedThisYear: 32,
      unit: 'hours',
      policyType: 'accruing',
    });
  });

  it('lists the time-off policies with no personal data at all', async () => {
    const out = await bambooTimeOffTypes.handler({}, fakeCtx());
    expect(out.types.map((t) => t.name)).toEqual(['PTO', 'Sick']);
    expect(JSON.stringify(out)).not.toContain('Emmanuel');
  });

  it('the timesheet summary aggregates rather than handing over raw entries', async () => {
    const out = await bambooTimesheetSummary.handler(
      { start: '2026-07-01', end: '2026-07-14', limit: 60 },
      fakeCtx(),
    );
    expect(out.totalHours).toBe(7.75);
    expect(out.peopleLogging).toBe(1);
    expect(out.byPerson[0]?.name).toBe('Emmanuel Castro');
    expect(out.byPerson[0]?.daysLogged).toBe(2);
    expect(out.unapprovedHours).toBe(3.25);
    expect(out.byProject[0]).toEqual({
      project: 'Click Call Sell',
      hours: 7.75,
      people: 1,
    });
    // Timestamps and timezones from the raw rows must not reach the model.
    expect(JSON.stringify(out)).not.toContain('America/New_York');
  });

  it('refuses a timesheet range too long to add up honestly', async () => {
    const out = await bambooTimesheetSummary.handler(
      { start: '2024-01-01', end: '2026-01-01', limit: 60 },
      fakeCtx(),
    );
    expect(out.configured).toBe(true);
    expect(out.reason).toMatch(/too long/i);
    expect(out.totalHours).toBe(0);
  });

  it('individual entries are scoped to one person', async () => {
    const out = await bambooTimesheetEntries.handler(
      {
        name: 'Emmanuel Castro',
        start: '2026-07-01',
        end: '2026-07-14',
        limit: 100,
      },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.entries).toHaveLength(2);
    expect(out.totalHours).toBe(7.75);
    expect(out.entries[1]?.task).toBe('Meetings');
    expect(out.entries[1]?.approved).toBe(false);
  });

  it('lists the projects someone can log time against', async () => {
    const out = await bambooEmployeeProjects.handler({ name: 'Emmanuel Castro' }, fakeCtx());
    expect(out.projects).toEqual([{ name: 'Click Call Sell', hasTasks: false }]);
  });

  it('documents are listed, flagged as payslips, and never opened', async () => {
    const out = await bambooListDocuments.handler(
      { name: 'Emmanuel Castro', payslipsOnly: false, limit: 50 },
      fakeCtx(),
    );
    expect(out.found).toBe(true);
    expect(out.totalDocuments).toBe(2);
    const payslip = out.documents.find((d) => d.isPayslip);
    expect(payslip?.name).toMatch(/1 April to 15 April/);
    expect(payslip?.sizeKb).toBe(19);
    expect(out.documents.find((d) => d.name === 'Signed NDA.pdf')?.visibleToEmployee).toBe(false);
    expect(out.guidance).toMatch(/not what is inside/i);

    const onlyPayslips = await bambooListDocuments.handler(
      { name: 'Emmanuel Castro', payslipsOnly: true, limit: 50 },
      fakeCtx(),
    );
    expect(onlyPayslips.documents).toHaveLength(1);
  });

  it('the field catalogue finds bill rate and names the restricted fields', async () => {
    const out = await bambooDescribeFields.handler(
      { search: 'rate', includeTables: true, limit: 80 },
      fakeCtx(),
    );
    expect(out.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Bill Rate', 'Pay rate', 'Bill Rate Effective Date']),
    );
    // The "- Currency code" companion rows are noise and must be dropped.
    expect(out.fields.map((f) => f.name)).not.toContain('Bill Rate - Currency code');
    // Bill Rate has no alias — it is one of the company's custom fields.
    expect(out.fields.find((f) => f.name === 'Bill Rate')?.custom).toBe(true);
    expect(out.tables.map((t) => t.name)).toContain('customBillRate1');
    // Numeric field ids are internal plumbing; nobody outside the package needs them.
    expect(JSON.stringify(out)).not.toContain('4631');
  });

  it('says plainly when BambooHR does not track something', async () => {
    const out = await bambooDescribeFields.handler(
      { search: 'stock ticker', includeTables: true, limit: 80 },
      fakeCtx(),
    );
    expect(out.fields).toEqual([]);
    expect(out.guidance).toMatch(/does not appear to track/i);
  });

  it('flags the identity and banking fields it will not read', async () => {
    const out = await bambooDescribeFields.handler(
      { search: 'bank', includeTables: false, limit: 80 },
      fakeCtx(),
    );
    expect(out.fields[0]?.restricted).toBe(true);
    expect(out.guidance).toMatch(/no tool that reads/i);
  });
});

// ---------------------------------------------------------------------------

describe('BambooHR tools — a rejected key and other upstream failures', () => {
  it('a 401 blames the key, not the user, and never leaks it', async () => {
    server.use(http.post(REPORTS, () => new HttpResponse(null, { status: 401 })));
    const out = await bambooListEmployees.handler({ status: 'active', limit: 50 }, fakeCtx());
    expect(out.configured).toBe(true);
    expect(out.employees).toEqual([]);
    expect(out.reason).toMatch(/rejected our key/i);
    expect(out.reason).not.toMatch(/401|test-key|Basic|stack/);
  });

  it('a 403 explains it is a permission problem an HR admin can fix', async () => {
    server.use(http.get(META_FIELDS, () => new HttpResponse(null, { status: 403 })));
    const out = await bambooDescribeFields.handler({ includeTables: true, limit: 80 }, fakeCtx());
    expect(out.reason).toMatch(/does not have permission/i);
  });

  it('a 429 comes back as a sentence, not an exception', async () => {
    server.use(http.get(WHOS_OUT, () => new HttpResponse(null, { status: 429 })));
    const out = await bambooWhosOut.handler({}, fakeCtx());
    expect(out.configured).toBe(true);
    expect(out.absences).toEqual([]);
    expect(out.reason).toMatch(/rate-limiting/i);
    expect(out.reason).not.toMatch(/429|Error/);
  });

  it('a 500 is described as their side, not ours', async () => {
    server.use(http.post(REPORTS, () => new HttpResponse(null, { status: 500 })));
    const out = await bambooHeadcount.handler(
      { groupBy: 'client', status: 'active', limit: 30 },
      fakeCtx(),
    );
    expect(out.reason).toMatch(/trouble on their side/i);
  });

  it('a missing bill-rate table is treated as no data, not as a failure', async () => {
    server.use(
      http.get(TABLE, ({ params }) => {
        if (params.table === 'customBillRate1') return new HttpResponse(null, { status: 404 });
        return HttpResponse.json([
          {
            id: '1',
            startDate: '2024-04-01',
            rate: { currency: 'USD', value: '4000.00' },
          },
        ]);
      }),
    );
    const out = await bambooCompensationHistory.handler({ name: 'Emmanuel Castro' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.currentBillRate).toBeNull();
    expect(out.guidance).toMatch(/no bill rate has ever been recorded/i);
  });

  it('an unreadable body does not throw', async () => {
    server.use(http.post(REPORTS, () => new HttpResponse('<html>nope</html>', { status: 200 })));
    const out = await bambooListEmployees.handler({ status: 'active', limit: 50 }, fakeCtx());
    expect(out.configured).toBe(true);
    expect(out.reason).toMatch(/could not read/i);
  });
});

// ---------------------------------------------------------------------------

describe('BambooHR tools — security classification', () => {
  const at = (id: string, input: unknown, surface: 'web' | 'schedule' = 'web') =>
    classify({
      tool: { id },
      input,
      ctx: { now: new Date(Date.UTC(2026, 0, 1, 17, 0, 0)) },
      surface,
    });

  it('treats anything carrying a rate as compensation data', () => {
    for (const id of [
      'bamboo.get_employee',
      'bamboo.compensation_history',
      'bamboo.compensation_report',
    ]) {
      expect(at(id, { name: 'Emmanuel Castro' }).sensitivity).toBe('financial');
    }
  });

  it('gates a whole-roster compensation export behind a human', () => {
    const c = at('bamboo.compensation_report', { status: 'active' });
    expect(c.sensitivity).toBe('financial');
    expect(c.blastRadius).toBe('bulk');
    expect(c.riskLevel).toBe('high');
    expect(c.signals).toContain('bulk-read');
    expect(decide(c)).toBe('confirm');
  });

  it('refuses a compensation export running unattended on a schedule', () => {
    const c = at('bamboo.compensation_report', { status: 'active' }, 'schedule');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c)).toBe('block');
  });

  it('treats the rest of the roster as personal data, not compensation', () => {
    const c = at('bamboo.list_employees', { status: 'active' });
    expect(c.sensitivity).toBe('pii');
    expect(c.blastRadius).toBe('read');
    expect(decide(c)).toBe('allow');
  });

  it('lets aggregates and metadata through without friction', () => {
    for (const id of [
      'bamboo.headcount',
      'bamboo.describe_fields',
      'bamboo.time_off_types',
      'bamboo.employee_projects',
    ]) {
      const c = at(id, {});
      expect(c.sensitivity).toBe('internal');
      expect(c.riskLevel).toBe('low');
      expect(decide(c)).toBe('allow');
    }
  });

  it('lets a scheduled headcount or who-is-out run unattended', () => {
    expect(decide(at('bamboo.headcount', { groupBy: 'client' }, 'schedule'))).toBe('allow');
    expect(decide(at('bamboo.whos_out', {}, 'schedule'))).toBe('allow');
  });

  it('a whole-roster read is bulk once it asks for everybody', () => {
    const c = at('bamboo.list_employees', { status: 'any', limit: 200 });
    expect(c.blastRadius).toBe('bulk');
    expect(decide(c)).toBe('confirm');
  });

  it('keeps every tool in the family read-only — nothing writes back to BambooHR', () => {
    for (const id of [
      'bamboo.list_employees',
      'bamboo.get_employee',
      'bamboo.compensation_history',
      'bamboo.employment_history',
      'bamboo.org_chart',
      'bamboo.headcount',
      'bamboo.recently_changed',
      'bamboo.whos_out',
      'bamboo.time_off_requests',
      'bamboo.time_off_balance',
      'bamboo.time_off_types',
      'bamboo.timesheet_summary',
      'bamboo.timesheet_entries',
      'bamboo.employee_projects',
      'bamboo.list_documents',
      'bamboo.describe_fields',
    ]) {
      expect(at(id, {}).blastRadius).toBe('read');
    }
  });
});
