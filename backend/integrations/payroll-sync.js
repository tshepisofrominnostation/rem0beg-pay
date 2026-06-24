/**
 * Rem0Beg Pay — Payroll Integration API (Netlify Function)
 * =========================================================
 * Endpoint: /.netlify/functions/payroll-sync
 * Methods : GET (test connection), POST (run sync)
 *
 * All monetary values returned as strings to preserve Decimal precision.
 */

// ── Mock Payroll Data ─────────────────────────────────────────

const MOCK_DATA = {
  SAGE_300: {
    meta: { version:'3.2.1', auth:'Bearer OAuth2', endpoint:'https://sage300.api.co.za/v1' },
    employees: [
      { ref:'SAGE-001', name:'Nomsa Dlamini',   title:'Senior Developer',      dept:'Engineering',     salary:'28500.00', bank:'Capitec ****4829',     status:'ACTIVE',   hired:'2024-03-15' },
      { ref:'SAGE-002', name:'Sipho Khumalo',   title:'UX Designer',           dept:'Product',         salary:'22000.00', bank:'FNB ****7741',         status:'ACTIVE',   hired:'2023-07-01' },
      { ref:'SAGE-003', name:'Lerato Mokoena',  title:'Finance Manager',       dept:'Finance',         salary:'38000.00', bank:'Absa ****2210',        status:'ACTIVE',   hired:'2022-01-10' },
      { ref:'SAGE-004', name:'Bongani Sithole', title:'Support Engineer',      dept:'IT',              salary:'18000.00', bank:'Standard Bank ****9934',status:'INACTIVE', hired:'2021-09-20' },
      { ref:'SAGE-005', name:'Thandi Nkosi',    title:'HR Coordinator',        dept:'Human Resources', salary:'21000.00', bank:'Nedbank ****5513',      status:'ACTIVE',   hired:'2023-11-01' },
    ],
    shifts_today: [
      { ref:'SAGE-001', name:'Nomsa Dlamini',  clock_in:'08:02', clock_out:'17:05', hours:8.1,  type:'FULL',     earned:'129.55' },
      { ref:'SAGE-002', name:'Sipho Khumalo',  clock_in:'08:30', clock_out:'12:35', hours:4.1,  type:'HALF',     earned:'50.00'  },
      { ref:'SAGE-003', name:'Lerato Mokoena', clock_in:'07:55', clock_out:'19:10', hours:10.3, type:'OVERTIME', earned:'216.00' },
      { ref:'SAGE-004', name:'Bongani Sithole',clock_in:null,    clock_out:null,    hours:0,    type:'ABSENT',   earned:'0.00'   },
      { ref:'SAGE-005', name:'Thandi Nkosi',   clock_in:'08:00', clock_out:'17:00', hours:8,    type:'FULL',     earned:'95.45'  },
    ],
    monthly_payroll: [
      { ref:'SAGE-001', name:'Nomsa Dlamini',  gross:'36000.00', paye:'6480.00', uif:'148.72', pension:'1080.00', net:'28500.00', ewa_deduction:'315.00' },
      { ref:'SAGE-002', name:'Sipho Khumalo',  gross:'28000.00', paye:'4788.00', uif:'110.00', pension:'840.00',  net:'22000.00', ewa_deduction:'515.00' },
      { ref:'SAGE-003', name:'Lerato Mokoena', gross:'49000.00', paye:'9580.00', uif:'148.72', pension:'1470.00', net:'38000.00', ewa_deduction:'0.00'   },
      { ref:'SAGE-005', name:'Thandi Nkosi',   gross:'27000.00', paye:'4620.00', uif:'108.00', pension:'810.00',  net:'21000.00', ewa_deduction:'215.00' },
    ],
  },
  PAYSPACE: {
    meta: { version:'OData v1.1', auth:'OAuth2 client_credentials', endpoint:'https://api.payspace.com/odata/v1.1' },
    employees: [
      { ref:'PS-10001', name:'Zanele Mthembu',    title:'Operations Manager',       dept:'Operations', salary:'45000.00', bank:'Standard Bank ****3321', status:'ACTIVE', hired:'2020-06-01' },
      { ref:'PS-10002', name:'Andile Zwane',       title:'Warehouse Supervisor',     dept:'Logistics',  salary:'19500.00', bank:'TymeBank ****8877',      status:'ACTIVE', hired:'2021-03-15' },
      { ref:'PS-10003', name:'Precious Mahlangu',  title:'Payroll Administrator',    dept:'Finance',    salary:'24000.00', bank:'Absa ****6612',          status:'ACTIVE', hired:'2019-11-20' },
    ],
    quarantined: [
      { ref:'', name:'Unknown Employee', error:'Missing employee ref, invalid salary (NaN), invalid SA ID' }
    ],
    shifts_today: [
      { ref:'PS-10001', name:'Zanele Mthembu',   clock_in:'07:45', clock_out:'17:00', hours:9.25, type:'FULL', earned:'204.55' },
      { ref:'PS-10002', name:'Andile Zwane',      clock_in:'06:00', clock_out:'14:00', hours:8,    type:'FULL', earned:'88.64'  },
      { ref:'PS-10003', name:'Precious Mahlangu', clock_in:'09:00', clock_out:'13:00', hours:4,    type:'HALF', earned:'54.55'  },
    ],
    monthly_payroll: [
      { ref:'PS-10001', name:'Zanele Mthembu',   gross:'58500.00', paye:'12350.00', uif:'148.72', pension:'1755.00', net:'45000.00', ewa_deduction:'580.00' },
      { ref:'PS-10002', name:'Andile Zwane',      gross:'25000.00', paye:'4225.00',  uif:'100.00', pension:'750.00',  net:'19500.00', ewa_deduction:'215.00' },
      { ref:'PS-10003', name:'Precious Mahlangu', gross:'31200.00', paye:'5808.00',  uif:'124.80', pension:'936.00',  net:'24000.00', ewa_deduction:'0.00'   },
    ],
  },
  PASTEL: {
    meta: { version:'CSV/SFTP', auth:'SFTP keypair', endpoint:'sftp://pastel.nkosi.co.za:22' },
    employees: [
      { ref:'PAT-001', name:'Lungelo Dube',      title:'Accountant',    dept:'Finance', salary:'32000.00', bank:'FNB ****1122',    status:'ACTIVE', hired:'2018-05-14' },
      { ref:'PAT-002', name:'Miriam Shabalala',  title:'Receptionist',  dept:'Admin',   salary:'12500.00', bank:'Capitec ****3344', status:'ACTIVE', hired:'2022-08-01' },
      { ref:'PAT-003', name:'Sifiso Nxumalo',    title:'IT Technician', dept:'IT',      salary:'17500.00', bank:'Absa ****5566',    status:'ACTIVE', hired:'2020-01-07' },
    ],
    shifts_today: [
      { ref:'PAT-001', name:'Lungelo Dube',     clock_in:'08:00', clock_out:'17:00', hours:8, type:'FULL',   earned:'145.45' },
      { ref:'PAT-002', name:'Miriam Shabalala', clock_in:'08:00', clock_out:'17:00', hours:8, type:'FULL',   earned:'56.82'  },
      { ref:'PAT-003', name:'Sifiso Nxumalo',   clock_in:null,    clock_out:null,    hours:0, type:'ABSENT', earned:'0.00'   },
    ],
    monthly_payroll: [
      { ref:'PAT-001', name:'Lungelo Dube',     gross:'42000.00', paye:'8000.00', uif:'148.72', pension:'1260.00', net:'32000.00', ewa_deduction:'330.00' },
      { ref:'PAT-002', name:'Miriam Shabalala', gross:'16200.00', paye:'2836.00', uif:'64.80',  pension:'486.00',  net:'12500.00', ewa_deduction:'115.00' },
      { ref:'PAT-003', name:'Sifiso Nxumalo',   gross:'22900.00', paye:'4163.00', uif:'91.60',  pension:'687.00',  net:'17500.00', ewa_deduction:'0.00'   },
    ],
  },
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(n)   { return Math.floor(Math.random() * n); }
function now()     { return new Date().toISOString(); }
function today()   { return new Date().toISOString().slice(0,10); }

// ── Handler ───────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const params  = event.queryStringParameters || {};
  const system  = (params.system || 'SAGE_300').toUpperCase();
  const action  = params.action  || 'test';
  const period  = params.period  || today().slice(0,7);

  const data = MOCK_DATA[system];
  if (!data) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `Unknown system: ${system}. Use SAGE_300, PAYSPACE, or PASTEL.` }),
    };
  }

  const latency = 80 + rand(300);
  await delay(latency);

  const base = { system, action, timestamp: now(), latency_ms: latency, meta: data.meta };

  switch(action) {

    case 'test': {
      return { statusCode:200, headers, body: JSON.stringify({
        ...base,
        status: 'CONNECTED',
        message: `✓ ${system} connection successful`,
        details: data.meta,
      })};
    }

    case 'employees': {
      return { statusCode:200, headers, body: JSON.stringify({
        ...base,
        status: 'SUCCESS',
        record_count: data.employees.length,
        employees: data.employees,
        quarantined: data.quarantined || [],
        quarantine_count: (data.quarantined || []).length,
      })};
    }

    case 'shifts': {
      const date = params.date || today();
      return { statusCode:200, headers, body: JSON.stringify({
        ...base,
        status: 'SUCCESS',
        date,
        record_count: data.shifts_today.length,
        shifts: data.shifts_today,
        daily_total_earned: data.shifts_today
          .reduce((s,r) => s + parseFloat(r.earned||'0'), 0).toFixed(2),
      })};
    }

    case 'payroll': {
      return { statusCode:200, headers, body: JSON.stringify({
        ...base,
        status: 'SUCCESS',
        period,
        record_count: data.monthly_payroll.length,
        payroll: data.monthly_payroll,
        totals: {
          gross:     data.monthly_payroll.reduce((s,r)=>s+parseFloat(r.gross),0).toFixed(2),
          net:       data.monthly_payroll.reduce((s,r)=>s+parseFloat(r.net),0).toFixed(2),
          paye:      data.monthly_payroll.reduce((s,r)=>s+parseFloat(r.paye),0).toFixed(2),
          ewa_total: data.monthly_payroll.reduce((s,r)=>s+parseFloat(r.ewa_deduction),0).toFixed(2),
        },
      })};
    }

    case 'push_deductions': {
      const body = event.body ? JSON.parse(event.body) : {};
      const deductions = body.deductions || data.monthly_payroll
        .filter(r => parseFloat(r.ewa_deduction) > 0)
        .map(r => ({ ref: r.ref, name: r.name, amount: r.ewa_deduction }));

      const batchRef = `${system}-BATCH-${Date.now()}`;
      return { statusCode:200, headers, body: JSON.stringify({
        ...base,
        status: 'SUCCESS',
        batch_ref: batchRef,
        accepted: deductions.length,
        rejected: 0,
        message: `✓ ${deductions.length} EWA deductions queued in ${system} for ${period}`,
        deductions,
      })};
    }

    default:
      return { statusCode:400, headers, body: JSON.stringify({ error:`Unknown action: ${action}` })};
  }
};
