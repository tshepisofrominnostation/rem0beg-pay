/**
 * Rem0Beg Pay — Payroll System Integration Layer
 * ================================================
 * Unified connector interface for:
 *   - Sage 300 People (REST API simulation)
 *   - PaySpace (REST API simulation)
 *   - Pastel Payroll (SFTP/CSV simulation)
 *
 * Each connector implements the PayrollConnector interface.
 * In production, swap the mock HTTP responses for real API calls.
 *
 * CURRENCY SAFETY: All salary/earning values fetched as strings.
 * Convert to Decimal.js at the service layer — never native floats.
 *
 * Author: Tshepiso Freddy Thosago | June 2026
 */

import Decimal from 'decimal.js';
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ── Shared Types ──────────────────────────────────────────────

export type ShiftType = 'FULL' | 'HALF' | 'OVERTIME' | 'ABSENT' | 'PUBLIC_HOLIDAY';
export type SyncStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'QUARANTINED';
export type PayrollSystem = 'SAGE_300' | 'PAYSPACE' | 'PASTEL';

export interface PayrollEmployee {
  external_ref:            string;   // Payroll system's own employee ID
  first_name:              string;
  last_name:               string;
  id_number:               string;   // SA ID / passport
  email:                   string;
  job_title:               string;
  department:              string;
  base_net_monthly_salary: string;   // STRING — parse with Decimal.js
  bank_name:               string;
  bank_account_masked:     string;   // e.g. '****4829'
  employment_status:       'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  hire_date:               string;   // YYYY-MM-DD
}

export interface DailyShiftRecord {
  external_ref:  string;
  employee_name: string;
  date:          string;          // YYYY-MM-DD
  clock_in:      string | null;   // HH:MM
  clock_out:     string | null;
  hours_worked:  number;
  shift_type:    ShiftType;
  site:          string;
  approved_by:   string;
}

export interface MonthlyPayrollRecord {
  external_ref:            string;
  employee_name:           string;
  pay_period:              string;   // 'YYYY-MM'
  gross_salary:            string;   // STRING
  deductions_paye:         string;
  deductions_uif:          string;
  deductions_pension:      string;
  net_salary:              string;   // STRING — what EWA uses
  ewa_deduction:           string;   // EWA amount to deduct this month
  leave_days_taken:        number;
  overtime_hours:          number;
}

export interface SyncResponse {
  source:           PayrollSystem;
  sync_date:        string;
  status:           SyncStatus;
  employees?:       PayrollEmployee[];
  shifts?:          DailyShiftRecord[];
  payroll_records?: MonthlyPayrollRecord[];
  record_count:     number;
  errors:           SyncError[];
  metadata:         Record<string, string | number>;
}

export interface SyncError {
  row:     number | string;
  field:   string;
  value:   string;
  message: string;
}

// ── Connector Interface ───────────────────────────────────────

export interface PayrollConnector {
  system:      PayrollSystem;
  companyName: string;
  testConnection(): Promise<{ ok: boolean; latency: number; message: string }>;
  fetchEmployees(): Promise<SyncResponse>;
  fetchDailyShifts(date: string): Promise<SyncResponse>;
  fetchMonthlyPayroll(period: string): Promise<SyncResponse>;
  pushEwaDeductions(deductions: EwaDeduction[]): Promise<PushResult>;
}

export interface EwaDeduction {
  external_ref:    string;
  ewa_amount:      string;   // STRING — Decimal precision
  fee_amount:      string;
  total_deduction: string;
  pay_period:      string;
  reference:       string;
}

export interface PushResult {
  accepted:  number;
  rejected:  number;
  errors:    SyncError[];
  batch_ref: string;
}

// ════════════════════════════════════════════════════════════
// CONNECTOR 1: SAGE 300 PEOPLE
// Real endpoint: https://sage300.yourcompany.co.za/api/v1/
// Auth: Bearer token (OAuth2 client_credentials)
// ════════════════════════════════════════════════════════════

export class Sage300Connector implements PayrollConnector {
  system:      PayrollSystem = 'SAGE_300';
  companyName: string;
  private apiUrl:    string;
  private apiKey:    string;

  constructor(companyName: string, apiUrl: string, apiKey: string) {
    this.companyName = companyName;
    this.apiUrl      = apiUrl;
    this.apiKey      = apiKey;
  }

  async testConnection() {
    const start = Date.now();
    // Mock: simulate Sage 300 REST ping
    await delay(120 + rand(80));
    const latency = Date.now() - start;
    console.log(`[SAGE] ✓ Connection OK | ${this.companyName} | ${latency}ms`);
    return { ok: true, latency, message: `Sage 300 API reachable at ${this.apiUrl}` };
  }

  async fetchEmployees(): Promise<SyncResponse> {
    await delay(200 + rand(150));
    console.log(`[SAGE] Fetching employees for ${this.companyName}…`);

    const employees: PayrollEmployee[] = [
      {
        external_ref: 'SAGE-EMP-001', first_name: 'Nomsa', last_name: 'Dlamini',
        id_number: '9001015009087', email: 'nomsa.dlamini@realvue.co.za',
        job_title: 'Senior Developer', department: 'Engineering',
        base_net_monthly_salary: '28500.00', bank_name: 'Capitec',
        bank_account_masked: '****4829', employment_status: 'ACTIVE',
        hire_date: '2024-03-15',
      },
      {
        external_ref: 'SAGE-EMP-002', first_name: 'Sipho', last_name: 'Khumalo',
        id_number: '8806024008083', email: 'sipho.khumalo@realvue.co.za',
        job_title: 'UX Designer', department: 'Product',
        base_net_monthly_salary: '22000.00', bank_name: 'FNB',
        bank_account_masked: '****7741', employment_status: 'ACTIVE',
        hire_date: '2023-07-01',
      },
      {
        external_ref: 'SAGE-EMP-003', first_name: 'Lerato', last_name: 'Mokoena',
        id_number: '9504120099081', email: 'lerato.mokoena@realvue.co.za',
        job_title: 'Finance Manager', department: 'Finance',
        base_net_monthly_salary: '38000.00', bank_name: 'Absa',
        bank_account_masked: '****2210', employment_status: 'ACTIVE',
        hire_date: '2022-01-10',
      },
      {
        external_ref: 'SAGE-EMP-004', first_name: 'Bongani', last_name: 'Sithole',
        id_number: '8712085012087', email: 'bongani.sithole@realvue.co.za',
        job_title: 'Support Engineer', department: 'IT',
        base_net_monthly_salary: '18000.00', bank_name: 'Standard Bank',
        bank_account_masked: '****9934', employment_status: 'INACTIVE',
        hire_date: '2021-09-20',
      },
      {
        external_ref: 'SAGE-EMP-005', first_name: 'Thandi', last_name: 'Nkosi',
        id_number: '9210154007080', email: 'thandi.nkosi@realvue.co.za',
        job_title: 'HR Coordinator', department: 'Human Resources',
        base_net_monthly_salary: '21000.00', bank_name: 'Nedbank',
        bank_account_masked: '****5513', employment_status: 'ACTIVE',
        hire_date: '2023-11-01',
      },
    ];

    return {
      source: 'SAGE_300', sync_date: today(), status: 'SUCCESS',
      employees, record_count: employees.length, errors: [],
      metadata: { api_version: '3.2.1', tenant_id: 'RVT-001', response_time_ms: 287 },
    };
  }

  async fetchDailyShifts(date: string): Promise<SyncResponse> {
    await delay(150 + rand(100));
    console.log(`[SAGE] Fetching shifts for ${date}…`);

    const shifts: DailyShiftRecord[] = [
      { external_ref:'SAGE-EMP-001', employee_name:'Nomsa Dlamini', date, clock_in:'08:02', clock_out:'17:05', hours_worked:8.1, shift_type:'FULL', site:'Sandton HQ', approved_by:'Manager: Lerato Mokoena' },
      { external_ref:'SAGE-EMP-002', employee_name:'Sipho Khumalo', date, clock_in:'08:30', clock_out:'12:35', hours_worked:4.1, shift_type:'HALF', site:'Remote', approved_by:'Manager: Lerato Mokoena' },
      { external_ref:'SAGE-EMP-003', employee_name:'Lerato Mokoena', date, clock_in:'07:55', clock_out:'19:10', hours_worked:10.3, shift_type:'OVERTIME', site:'Sandton HQ', approved_by:'Director: Auto-approved' },
      { external_ref:'SAGE-EMP-004', employee_name:'Bongani Sithole', date, clock_in:null, clock_out:null, hours_worked:0, shift_type:'ABSENT', site:'N/A', approved_by:'HR: Thandi Nkosi' },
      { external_ref:'SAGE-EMP-005', employee_name:'Thandi Nkosi', date, clock_in:'08:00', clock_out:'17:00', hours_worked:8, shift_type:'FULL', site:'Sandton HQ', approved_by:'Director: Auto-approved' },
    ];

    return {
      source: 'SAGE_300', sync_date: date, status: 'SUCCESS',
      shifts, record_count: shifts.length, errors: [],
      metadata: { pay_period: date.slice(0,7), working_days_this_month: 22 },
    };
  }

  async fetchMonthlyPayroll(period: string): Promise<SyncResponse> {
    await delay(250 + rand(200));
    console.log(`[SAGE] Fetching monthly payroll for ${period}…`);

    const records: MonthlyPayrollRecord[] = [
      { external_ref:'SAGE-EMP-001', employee_name:'Nomsa Dlamini', pay_period:period, gross_salary:'36000.00', deductions_paye:'6480.00', deductions_uif:'148.72', deductions_pension:'1080.00', net_salary:'28500.00', ewa_deduction:'315.00', leave_days_taken:0, overtime_hours:0 },
      { external_ref:'SAGE-EMP-002', employee_name:'Sipho Khumalo', pay_period:period, gross_salary:'28000.00', deductions_paye:'4788.00', deductions_uif:'110.00', deductions_pension:'840.00', net_salary:'22000.00', ewa_deduction:'515.00', leave_days_taken:1, overtime_hours:0 },
      { external_ref:'SAGE-EMP-003', employee_name:'Lerato Mokoena', pay_period:period, gross_salary:'49000.00', deductions_paye:'9580.00', deductions_uif:'148.72', deductions_pension:'1470.00', net_salary:'38000.00', ewa_deduction:'0.00', leave_days_taken:0, overtime_hours:6 },
      { external_ref:'SAGE-EMP-005', employee_name:'Thandi Nkosi', pay_period:period, gross_salary:'27000.00', deductions_paye:'4620.00', deductions_uif:'108.00', deductions_pension:'810.00', net_salary:'21000.00', ewa_deduction:'215.00', leave_days_taken:0, overtime_hours:0 },
    ];

    return {
      source: 'SAGE_300', sync_date: today(), status: 'SUCCESS',
      payroll_records: records, record_count: records.length, errors: [],
      metadata: { pay_period: period, run_date: today(), run_by: 'SYSTEM_CRON' },
    };
  }

  async pushEwaDeductions(deductions: EwaDeduction[]): Promise<PushResult> {
    await delay(300 + rand(200));
    console.log(`[SAGE] Pushing ${deductions.length} EWA deductions…`);
    // Validate each deduction before mock-accepting
    const errors: SyncError[] = [];
    let accepted = 0;
    deductions.forEach((d, i) => {
      const amt = new Decimal(d.total_deduction);
      if (amt.isNaN() || amt.isNegative()) {
        errors.push({ row: i+1, field:'total_deduction', value:d.total_deduction, message:'Invalid amount' });
      } else { accepted++; }
    });
    const batch_ref = `SAGE-BATCH-${Date.now()}`;
    console.log(`[SAGE] ✓ Push complete | Accepted: ${accepted} | Rejected: ${errors.length} | Ref: ${batch_ref}`);
    return { accepted, rejected: errors.length, errors, batch_ref };
  }
}

// ════════════════════════════════════════════════════════════
// CONNECTOR 2: PAYSPACE
// Real endpoint: https://api.payspace.com/odata/v1.1/
// Auth: Bearer token (OAuth2)
// ════════════════════════════════════════════════════════════

export class PaySpaceConnector implements PayrollConnector {
  system:      PayrollSystem = 'PAYSPACE';
  companyName: string;
  private apiUrl:   string;
  private clientId: string;
  private secret:   string;

  constructor(companyName: string, apiUrl: string, clientId: string, secret: string) {
    this.companyName = companyName;
    this.apiUrl      = apiUrl;
    this.clientId    = clientId;
    this.secret      = secret;
  }

  async testConnection() {
    const start = Date.now();
    await delay(90 + rand(60));
    const latency = Date.now() - start;
    console.log(`[PAYSPACE] ✓ Connection OK | ${this.companyName} | ${latency}ms`);
    return { ok: true, latency, message: `PaySpace OData API reachable | ClientID: ${this.clientId.slice(0,8)}***` };
  }

  async fetchEmployees(): Promise<SyncResponse> {
    await delay(180 + rand(120));
    console.log(`[PAYSPACE] Fetching employees for ${this.companyName}…`);

    const employees: PayrollEmployee[] = [
      {
        external_ref: 'PS-10001', first_name: 'Zanele', last_name: 'Mthembu',
        id_number: '9303125010082', email: 'zanele.mthembu@amandla.co.za',
        job_title: 'Operations Manager', department: 'Operations',
        base_net_monthly_salary: '45000.00', bank_name: 'Standard Bank',
        bank_account_masked: '****3321', employment_status: 'ACTIVE',
        hire_date: '2020-06-01',
      },
      {
        external_ref: 'PS-10002', first_name: 'Andile', last_name: 'Zwane',
        id_number: '9107045011081', email: 'andile.zwane@amandla.co.za',
        job_title: 'Warehouse Supervisor', department: 'Logistics',
        base_net_monthly_salary: '19500.00', bank_name: 'TymeBank',
        bank_account_masked: '****8877', employment_status: 'ACTIVE',
        hire_date: '2021-03-15',
      },
      {
        external_ref: 'PS-10003', first_name: 'Precious', last_name: 'Mahlangu',
        id_number: '8805154012080', email: 'precious.mahlangu@amandla.co.za',
        job_title: 'Payroll Administrator', department: 'Finance',
        base_net_monthly_salary: '24000.00', bank_name: 'Absa',
        bank_account_masked: '****6612', employment_status: 'ACTIVE',
        hire_date: '2019-11-20',
      },
      {
        // Intentionally corrupt row — tests quarantine handling
        external_ref: '', first_name: 'Unknown', last_name: '',
        id_number: 'INVALID', email: 'not-an-email',
        job_title: '', department: '',
        base_net_monthly_salary: 'NaN', bank_name: '',
        bank_account_masked: '', employment_status: 'ACTIVE',
        hire_date: '0000-00-00',
      },
    ];

    // Validate and quarantine bad rows
    const valid: PayrollEmployee[] = [];
    const errors: SyncError[] = [];
    employees.forEach((e, i) => {
      const errs = validateEmployee(e, i+1);
      if (errs.length) { errors.push(...errs); }
      else { valid.push(e); }
    });

    return {
      source: 'PAYSPACE', sync_date: today(),
      status: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
      employees: valid, record_count: valid.length, errors,
      metadata: { odata_version:'1.1', company_code:'AMD-001', quarantined: errors.length },
    };
  }

  async fetchDailyShifts(date: string): Promise<SyncResponse> {
    await delay(140 + rand(80));
    console.log(`[PAYSPACE] Fetching shifts for ${date}…`);

    const shifts: DailyShiftRecord[] = [
      { external_ref:'PS-10001', employee_name:'Zanele Mthembu', date, clock_in:'07:45', clock_out:'17:00', hours_worked:9.25, shift_type:'FULL', site:'Durban Office', approved_by:'Director: Auto' },
      { external_ref:'PS-10002', employee_name:'Andile Zwane', date, clock_in:'06:00', clock_out:'14:00', hours_worked:8, shift_type:'FULL', site:'Warehouse A', approved_by:'Manager: Zanele Mthembu' },
      { external_ref:'PS-10003', employee_name:'Precious Mahlangu', date, clock_in:'09:00', clock_out:'13:00', hours_worked:4, shift_type:'HALF', site:'Remote', approved_by:'Manager: Zanele Mthembu' },
    ];

    return {
      source: 'PAYSPACE', sync_date: date, status: 'SUCCESS',
      shifts, record_count: shifts.length, errors: [],
      metadata: { working_days_month: 22, public_holidays: 0 },
    };
  }

  async fetchMonthlyPayroll(period: string): Promise<SyncResponse> {
    await delay(220 + rand(150));
    console.log(`[PAYSPACE] Fetching monthly payroll for ${period}…`);

    const records: MonthlyPayrollRecord[] = [
      { external_ref:'PS-10001', employee_name:'Zanele Mthembu', pay_period:period, gross_salary:'58500.00', deductions_paye:'12350.00', deductions_uif:'148.72', deductions_pension:'1755.00', net_salary:'45000.00', ewa_deduction:'580.00', leave_days_taken:0, overtime_hours:5 },
      { external_ref:'PS-10002', employee_name:'Andile Zwane', pay_period:period, gross_salary:'25000.00', deductions_paye:'4225.00', deductions_uif:'100.00', deductions_pension:'750.00', net_salary:'19500.00', ewa_deduction:'215.00', leave_days_taken:2, overtime_hours:0 },
      { external_ref:'PS-10003', employee_name:'Precious Mahlangu', pay_period:period, gross_salary:'31200.00', deductions_paye:'5808.00', deductions_uif:'124.80', deductions_pension:'936.00', net_salary:'24000.00', ewa_deduction:'0.00', leave_days_taken:0, overtime_hours:0 },
    ];

    return {
      source: 'PAYSPACE', sync_date: today(), status: 'SUCCESS',
      payroll_records: records, record_count: records.length, errors: [],
      metadata: { pay_period: period, run_date: today() },
    };
  }

  async pushEwaDeductions(deductions: EwaDeduction[]): Promise<PushResult> {
    await delay(280 + rand(150));
    console.log(`[PAYSPACE] Pushing ${deductions.length} EWA deductions…`);
    const batch_ref = `PS-BATCH-${Date.now()}`;
    return { accepted: deductions.length, rejected: 0, errors: [], batch_ref };
  }
}

// ════════════════════════════════════════════════════════════
// CONNECTOR 3: PASTEL PAYROLL (SFTP / CSV)
// Pastel doesn't have a REST API — it reads/writes CSV files
// via SFTP. We simulate the file parse here.
// ════════════════════════════════════════════════════════════

export class PastelConnector implements PayrollConnector {
  system:      PayrollSystem = 'PASTEL';
  companyName: string;
  private sftpHost: string;
  private sftpUser: string;

  constructor(companyName: string, sftpHost: string, sftpUser: string) {
    this.companyName = companyName;
    this.sftpHost    = sftpHost;
    this.sftpUser    = sftpUser;
  }

  async testConnection() {
    const start = Date.now();
    await delay(300 + rand(200)); // SFTP is slower
    const latency = Date.now() - start;
    console.log(`[PASTEL] ✓ SFTP connection OK | ${this.sftpHost} | ${latency}ms`);
    return { ok: true, latency, message: `Pastel SFTP reachable at ${this.sftpHost} as ${this.sftpUser}` };
  }

  async fetchEmployees(): Promise<SyncResponse> {
    await delay(400 + rand(200));
    console.log(`[PASTEL] Parsing employee CSV from SFTP…`);

    // Simulates parsing a Pastel-exported CSV file
    const csvRows = `
EMP_CODE,FIRSTNAME,LASTNAME,ID_NUMBER,EMAIL,JOB_TITLE,DEPARTMENT,NET_SALARY,BANK,ACCOUNT_MASKED,STATUS,HIRE_DATE
PAT-001,Lungelo,Dube,8901025013081,lungelo.dube@nkosi.co.za,Accountant,Finance,32000.00,FNB,****1122,A,2018-05-14
PAT-002,Miriam,Shabalala,9205104008082,miriam.shabalala@nkosi.co.za,Receptionist,Admin,12500.00,Capitec,****3344,A,2022-08-01
PAT-003,Sifiso,Nxumalo,8604085009083,sifiso.nxumalo@nkosi.co.za,IT Technician,IT,17500.00,Absa,****5566,A,2020-01-07
`.trim().split('\n').slice(1); // Remove header

    const employees: PayrollEmployee[] = csvRows.map(row => {
      const cols = row.split(',');
      return {
        external_ref: cols[0], first_name: cols[1], last_name: cols[2],
        id_number: cols[3], email: cols[4], job_title: cols[5],
        department: cols[6], base_net_monthly_salary: cols[7],
        bank_name: cols[8], bank_account_masked: cols[9],
        employment_status: cols[10] === 'A' ? 'ACTIVE' : 'INACTIVE',
        hire_date: cols[11],
      };
    });

    return {
      source: 'PASTEL', sync_date: today(), status: 'SUCCESS',
      employees, record_count: employees.length, errors: [],
      metadata: { sftp_host: this.sftpHost, file: 'employees_export.csv', file_rows: employees.length },
    };
  }

  async fetchDailyShifts(date: string): Promise<SyncResponse> {
    await delay(500 + rand(300));
    console.log(`[PASTEL] Parsing attendance CSV from SFTP for ${date}…`);

    // Pastel doesn't have real-time shifts — returns basic daily attendance
    const shifts: DailyShiftRecord[] = [
      { external_ref:'PAT-001', employee_name:'Lungelo Dube', date, clock_in:'08:00', clock_out:'17:00', hours_worked:8, shift_type:'FULL', site:'Pretoria Office', approved_by:'HR' },
      { external_ref:'PAT-002', employee_name:'Miriam Shabalala', date, clock_in:'08:00', clock_out:'17:00', hours_worked:8, shift_type:'FULL', site:'Pretoria Office', approved_by:'HR' },
      { external_ref:'PAT-003', employee_name:'Sifiso Nxumalo', date, clock_in:null, clock_out:null, hours_worked:0, shift_type:'ABSENT', site:'N/A', approved_by:'HR' },
    ];

    return {
      source: 'PASTEL', sync_date: date, status: 'SUCCESS',
      shifts, record_count: shifts.length, errors: [],
      metadata: { file: `attendance_${date}.csv`, method: 'SFTP_PULL' },
    };
  }

  async fetchMonthlyPayroll(period: string): Promise<SyncResponse> {
    await delay(600 + rand(300));
    console.log(`[PASTEL] Parsing monthly payroll CSV for ${period}…`);

    const records: MonthlyPayrollRecord[] = [
      { external_ref:'PAT-001', employee_name:'Lungelo Dube', pay_period:period, gross_salary:'42000.00', deductions_paye:'8000.00', deductions_uif:'148.72', deductions_pension:'1260.00', net_salary:'32000.00', ewa_deduction:'330.00', leave_days_taken:0, overtime_hours:0 },
      { external_ref:'PAT-002', employee_name:'Miriam Shabalala', pay_period:period, gross_salary:'16200.00', deductions_paye:'2836.00', deductions_uif:'64.80', deductions_pension:'486.00', net_salary:'12500.00', ewa_deduction:'115.00', leave_days_taken:1, overtime_hours:0 },
      { external_ref:'PAT-003', employee_name:'Sifiso Nxumalo', pay_period:period, gross_salary:'22900.00', deductions_paye:'4163.00', deductions_uif:'91.60', deductions_pension:'687.00', net_salary:'17500.00', ewa_deduction:'0.00', leave_days_taken:3, overtime_hours:0 },
    ];

    return {
      source: 'PASTEL', sync_date: today(), status: 'SUCCESS',
      payroll_records: records, record_count: records.length, errors: [],
      metadata: { pay_period: period, file: `payroll_${period}.csv`, method: 'SFTP_PULL' },
    };
  }

  async pushEwaDeductions(deductions: EwaDeduction[]): Promise<PushResult> {
    await delay(700 + rand(300));
    // Pastel: we generate a CSV and upload it via SFTP
    console.log(`[PASTEL] Generating EWA deduction CSV and uploading via SFTP…`);
    const batch_ref = `PAT-SFTP-${Date.now()}`;
    console.log(`[PASTEL] ✓ Uploaded: ewa_deductions_${today()}.csv | Ref: ${batch_ref}`);
    return { accepted: deductions.length, rejected: 0, errors: [], batch_ref };
  }
}

// ════════════════════════════════════════════════════════════
// CONNECTOR FACTORY
// Returns the right connector based on payroll system type
// ════════════════════════════════════════════════════════════

export function createConnector(
  system: PayrollSystem,
  config: Record<string, string>
): PayrollConnector {
  switch (system) {
    case 'SAGE_300':
      return new Sage300Connector(
        config.companyName,
        config.apiUrl || 'https://sage300.mock.local/api/v1',
        config.apiKey  || 'mock-sage-key'
      );
    case 'PAYSPACE':
      return new PaySpaceConnector(
        config.companyName,
        config.apiUrl    || 'https://api.payspace.com/odata/v1.1',
        config.clientId  || 'mock-client-id',
        config.secret    || 'mock-secret'
      );
    case 'PASTEL':
      return new PastelConnector(
        config.companyName,
        config.sftpHost || 'sftp.pastel.mock.local',
        config.sftpUser || 'rem0beg_svc'
      );
    default:
      throw new Error(`Unknown payroll system: ${system}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function rand(max: number) { return Math.floor(Math.random() * max); }
function today() { return new Date().toISOString().slice(0, 10); }

function validateEmployee(e: PayrollEmployee, row: number): SyncError[] {
  const errors: SyncError[] = [];
  if (!e.external_ref?.trim()) errors.push({ row, field:'external_ref', value:e.external_ref, message:'Missing employee reference' });
  if (!e.email?.includes('@'))  errors.push({ row, field:'email', value:e.email, message:'Invalid email address' });
  const sal = new Decimal(e.base_net_monthly_salary || 'NaN');
  if (sal.isNaN() || sal.isNegative()) errors.push({ row, field:'base_net_monthly_salary', value:e.base_net_monthly_salary, message:'Invalid salary value' });
  if (!/^\d{13}$/.test(e.id_number || '')) errors.push({ row, field:'id_number', value:e.id_number, message:'SA ID must be 13 digits' });
  return errors;
}
