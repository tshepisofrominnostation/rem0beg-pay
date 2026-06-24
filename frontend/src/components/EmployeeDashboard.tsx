/**
 * Rem0Beg Pay — Employee Dashboard (React + Tailwind)
 * =====================================================
 * Mobile-first single-screen EWA dashboard.
 * Displays earned balance, withdrawal slider, fee breakdown,
 * and recent transaction history.
 *
 * State is managed via React hooks. In production, connect
 * the API calls to your FastAPI / Express backend.
 *
 * Author: Tshepiso Freddy Thosago | June 2026
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────

interface EmployeeData {
  id: string;
  fullName: string;
  company: string;
  earnedThisMonth: number;      // e.g. 8500.00
  availableToWithdraw: number;  // e.g. 2125.00
  withdrawalCapPct: number;     // e.g. 0.25
  transactionFee: number;       // e.g. 15.00
  bankName: string;
  bankAccountMasked: string;    // e.g. '****4829'
}

interface Transaction {
  id: string;
  referenceNumber: string;
  amount: number;
  fee: number;
  status: 'PENDING' | 'APPROVED' | 'DISBURSED' | 'SETTLED' | 'REVERSED';
  createdAt: string;
  disbursedAt?: string;
}

type ModalState = 'hidden' | 'confirm' | 'processing' | 'success' | 'error';

// ── Mock API (replace with real fetch calls) ──────────────────

const mockEmployeeData: EmployeeData = {
  id:                  'emp-001',
  fullName:            'Nomsa Dlamini',
  company:             'Realvue Technologies (Pty) Ltd',
  earnedThisMonth:     8500.00,
  availableToWithdraw: 2125.00,
  withdrawalCapPct:    0.25,
  transactionFee:      15.00,
  bankName:            'Capitec Bank',
  bankAccountMasked:   '****4829',
};

const mockTransactions: Transaction[] = [
  { id: '1', referenceNumber: 'RBP-20260614-00042', amount: 1000, fee: 15, status: 'DISBURSED', createdAt: '2026-06-14', disbursedAt: '2026-06-14' },
  { id: '2', referenceNumber: 'RBP-20260608-00031', amount: 500,  fee: 15, status: 'SETTLED',  createdAt: '2026-06-08' },
  { id: '3', referenceNumber: 'RBP-20260601-00018', amount: 1500, fee: 15, status: 'SETTLED',  createdAt: '2026-06-01' },
  { id: '4', referenceNumber: 'RBP-20260524-00088', amount: 800,  fee: 15, status: 'SETTLED',  createdAt: '2026-05-24' },
];

// ── Helpers ───────────────────────────────────────────────────

function formatRand(amount: number): string {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

const STATUS_CONFIG: Record<Transaction['status'], { label: string; bg: string; text: string; dot: string }> = {
  PENDING:  { label: 'Pending',  bg: 'bg-amber-50',   text: 'text-amber-700',  dot: 'bg-amber-400' },
  APPROVED: { label: 'Approved', bg: 'bg-blue-50',    text: 'text-blue-700',   dot: 'bg-blue-400' },
  DISBURSED:{ label: 'Disbursed',bg: 'bg-emerald-50', text: 'text-emerald-700',dot: 'bg-emerald-400' },
  SETTLED:  { label: 'Settled',  bg: 'bg-slate-100',  text: 'text-slate-600',  dot: 'bg-slate-400' },
  REVERSED: { label: 'Reversed', bg: 'bg-red-50',     text: 'text-red-700',    dot: 'bg-red-400' },
};

// ════════════════════════════════════════════════════════════
// MAIN DASHBOARD COMPONENT
// ════════════════════════════════════════════════════════════

export default function EmployeeDashboard() {
  // ── Data state ────────────────────────────────────────────
  const [employee, setEmployee]       = useState<EmployeeData | null>(null);
  const [transactions, setTxns]       = useState<Transaction[]>([]);
  const [isLoading, setIsLoading]     = useState(true);

  // ── Withdrawal state ──────────────────────────────────────
  const [withdrawAmount, setWithdrawAmount] = useState(0);
  const [modalState, setModalState]         = useState<ModalState>('hidden');
  const [errorMessage, setErrorMessage]     = useState('');
  const sliderRef = useRef<HTMLInputElement>(null);

  // ── Load data ─────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      // Simulate API call latency
      await new Promise(r => setTimeout(r, 900));
      setEmployee(mockEmployeeData);
      setTxns(mockTransactions);
      setWithdrawAmount(Math.min(500, mockEmployeeData.availableToWithdraw));
      setIsLoading(false);
    };
    load();
  }, []);

  // ── Derived fee calculations ──────────────────────────────
  const fee             = employee?.transactionFee ?? 15;
  const maxWithdraw     = employee?.availableToWithdraw ?? 0;
  const netDisbursement = Math.max(withdrawAmount - fee, 0);
  const payrollDeduction = withdrawAmount + fee;
  const sliderPct       = maxWithdraw > 0 ? (withdrawAmount / maxWithdraw) * 100 : 0;

  // ── Handle slider change ──────────────────────────────────
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Round to nearest R50 for cleaner UX
    const raw   = parseFloat(e.target.value);
    const rounded = Math.round(raw / 50) * 50;
    setWithdrawAmount(Math.min(rounded, maxWithdraw));
  }, [maxWithdraw]);

  const handleAmountInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0;
    setWithdrawAmount(Math.min(val, maxWithdraw));
  }, [maxWithdraw]);

  // ── Withdrawal flow ───────────────────────────────────────
  const handleWithdrawClick = () => {
    if (withdrawAmount <= fee) {
      setErrorMessage(`Amount must be greater than the R${fee} fee.`);
      setModalState('error');
      return;
    }
    if (withdrawAmount > maxWithdraw) {
      setErrorMessage(`Amount exceeds your available balance of ${formatRand(maxWithdraw)}.`);
      setModalState('error');
      return;
    }
    setModalState('confirm');
  };

  const handleConfirmWithdrawal = async () => {
    setModalState('processing');

    // Simulate API call (replace with real POST to /api/withdrawals)
    await new Promise(r => setTimeout(r, 2000));

    // Mock success — in production handle actual API response
    const newTxn: Transaction = {
      id:              Date.now().toString(),
      referenceNumber: `RBP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Math.floor(Math.random()*99999)).padStart(5,'0')}`,
      amount:          withdrawAmount,
      fee,
      status:          'DISBURSED',
      createdAt:       new Date().toISOString().slice(0,10),
      disbursedAt:     new Date().toISOString().slice(0,10),
    };

    setTxns(prev => [newTxn, ...prev]);
    setEmployee(prev => prev ? {
      ...prev,
      availableToWithdraw: Math.max(prev.availableToWithdraw - withdrawAmount, 0),
      earnedThisMonth:     prev.earnedThisMonth,
    } : null);
    setWithdrawAmount(0);
    setModalState('success');
  };

  // ── Loading skeleton ──────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <span className="text-white font-black text-xl">R</span>
          </div>
          <p className="text-slate-400 text-sm animate-pulse">Loading your dashboard…</p>
        </div>
      </div>
    );
  }

  if (!employee) return null;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* ── Viewport wrapper (max-w-sm centres on wide screens) ── */}
      <div className="w-full max-w-sm mx-auto flex flex-col min-h-screen relative">

        {/* ════════ HEADER ════════ */}
        <header className="px-5 pt-12 pb-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center">
                <span className="text-white font-black text-sm">R</span>
              </div>
              <span className="text-white font-bold text-base">Rem0Beg Pay</span>
            </div>
            <p className="text-slate-400 text-xs">{employee.company}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
            <span className="text-emerald-400 font-bold text-sm">
              {employee.fullName.split(' ').map(n => n[0]).join('').slice(0,2)}
            </span>
          </div>
        </header>

        {/* ════════ GREETING ════════ */}
        <div className="px-5 mb-5">
          <h1 className="text-white font-bold text-xl">
            Hi, {employee.fullName.split(' ')[0]} 👋
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Here's your earnings snapshot for June 2026
          </p>
        </div>

        {/* ════════ MAIN BALANCE CARD ════════ */}
        <div className="mx-5 rounded-2xl overflow-hidden mb-4" style={{
          background: 'linear-gradient(135deg, #064e3b 0%, #065f46 50%, #047857 100%)',
          boxShadow: '0 20px 60px rgba(5, 150, 105, 0.3)',
        }}>
          {/* Card top */}
          <div className="px-5 pt-5 pb-4">
            <div className="flex justify-between items-start mb-6">
              <div>
                <p className="text-emerald-300/70 text-xs font-semibold uppercase tracking-widest mb-1">
                  Earned So Far This Month
                </p>
                <p className="text-white font-black text-4xl tracking-tight">
                  {formatRand(employee.earnedThisMonth)}
                </p>
                <p className="text-emerald-300/60 text-xs mt-1">
                  Based on shifts logged to date
                </p>
              </div>
              <div className="text-right">
                <p className="text-emerald-300/70 text-xs font-semibold uppercase tracking-widest mb-1">
                  Cap
                </p>
                <p className="text-white font-bold text-lg">
                  {(employee.withdrawalCapPct * 100).toFixed(0)}%
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mb-2">
              <div className="flex justify-between text-xs text-emerald-300/60 mb-1.5">
                <span>Withdrawn this month</span>
                <span>{formatRand(employee.earnedThisMonth * employee.withdrawalCapPct - employee.availableToWithdraw)} used</span>
              </div>
              <div className="h-1.5 bg-emerald-900/60 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-400 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(0, 100 - (employee.availableToWithdraw / (employee.earnedThisMonth * employee.withdrawalCapPct)) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Card bottom — Available balance */}
          <div className="bg-black/20 px-5 py-4 flex items-center justify-between">
            <div>
              <p className="text-emerald-300/70 text-xs font-semibold uppercase tracking-widest mb-0.5">
                Available to Withdraw Now
              </p>
              <p className="text-white font-black text-2xl">
                {formatRand(employee.availableToWithdraw)}
              </p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-emerald-400/20 border border-emerald-400/30 flex items-center justify-center">
              <svg width="22" height="22" fill="none" stroke="#4ade80" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
          </div>
        </div>

        {/* ════════ WITHDRAWAL PANEL ════════ */}
        <div className="mx-5 bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-4">
          <p className="text-white font-bold text-base mb-4">Withdraw Instantly</p>

          {/* Amount display + input */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-slate-400 text-xs mb-1">Selected amount</p>
              <div className="flex items-baseline gap-1">
                <span className="text-slate-400 text-sm font-medium">R</span>
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={handleAmountInput}
                  min={0}
                  max={maxWithdraw}
                  step={50}
                  className="bg-transparent text-white font-black text-3xl w-32 outline-none border-b border-emerald-500/40 pb-0.5 focus:border-emerald-400"
                />
              </div>
            </div>
            <div className="text-right">
              <p className="text-slate-400 text-xs mb-1">Max available</p>
              <p className="text-emerald-400 font-bold text-sm">{formatRand(maxWithdraw)}</p>
            </div>
          </div>

          {/* Slider */}
          <div className="relative mb-5">
            <input
              ref={sliderRef}
              type="range"
              min={0}
              max={maxWithdraw}
              step={50}
              value={withdrawAmount}
              onChange={handleSliderChange}
              className="w-full h-2 rounded-full appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #10b981 0%, #10b981 ${sliderPct}%, #1e293b ${sliderPct}%, #1e293b 100%)`,
              }}
            />
            {/* Quick select buttons */}
            <div className="flex gap-2 mt-3">
              {[0.25, 0.50, 0.75, 1.00].map(pct => (
                <button
                  key={pct}
                  onClick={() => setWithdrawAmount(Math.round(maxWithdraw * pct / 50) * 50)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all"
                  style={Math.abs(withdrawAmount - Math.round(maxWithdraw * pct / 50) * 50) < 50 ? {
                    background: '#10b981',
                    borderColor: '#10b981',
                    color: '#fff',
                  } : {
                    background: 'transparent',
                    borderColor: '#334155',
                    color: '#64748b',
                  }}
                >
                  {(pct * 100).toFixed(0)}%
                </button>
              ))}
            </div>
          </div>

          {/* Fee breakdown */}
          <div className="bg-slate-800/60 rounded-xl p-4 mb-4 space-y-2.5">
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-widest mb-3">
              Breakdown
            </p>
            <div className="flex justify-between items-center">
              <span className="text-slate-300 text-sm">Amount requested</span>
              <span className="text-white font-semibold text-sm">{formatRand(withdrawAmount)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300 text-sm">Transaction fee</span>
              <span className="text-amber-400 font-semibold text-sm">+ {formatRand(fee)}</span>
            </div>
            <div className="h-px bg-slate-700 my-1" />
            <div className="flex justify-between items-center">
              <span className="text-slate-300 text-sm">Payroll deduction (month-end)</span>
              <span className="text-white font-bold text-sm">{formatRand(payrollDeduction)}</span>
            </div>
            <div className="flex justify-between items-center">
              <div>
                <span className="text-slate-300 text-sm">You receive now</span>
                <p className="text-xs text-slate-500">{employee.bankName} {employee.bankAccountMasked}</p>
              </div>
              <span className="text-emerald-400 font-bold">{formatRand(withdrawAmount)}</span>
            </div>
          </div>

          {/* Withdraw button */}
          <button
            onClick={handleWithdrawClick}
            disabled={withdrawAmount <= fee || withdrawAmount <= 0}
            className="w-full py-4 rounded-xl font-bold text-sm transition-all duration-200 flex items-center justify-center gap-2"
            style={withdrawAmount > fee ? {
              background: 'linear-gradient(135deg, #10b981, #059669)',
              color: '#fff',
              boxShadow: '0 8px 24px rgba(16,185,129,0.35)',
            } : {
              background: '#1e293b',
              color: '#475569',
            }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
              <line x1="1" y1="10" x2="23" y2="10"/>
            </svg>
            Withdraw Instantly to My Bank Account
          </button>
          {withdrawAmount <= fee && withdrawAmount > 0 && (
            <p className="text-amber-400 text-xs text-center mt-2">
              Amount must exceed R{fee} transaction fee
            </p>
          )}
        </div>

        {/* ════════ RECENT TRANSACTIONS ════════ */}
        <div className="mx-5 mb-8">
          <p className="text-white font-bold text-base mb-3">Recent Withdrawals</p>
          <div className="space-y-2">
            {transactions.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">
                No withdrawals yet this cycle.
              </div>
            )}
            {transactions.map(txn => {
              const cfg = STATUS_CONFIG[txn.status];
              return (
                <div
                  key={txn.id}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-slate-800 flex items-center justify-center flex-shrink-0">
                      <svg width="16" height="16" fill="none" stroke="#64748b" strokeWidth="1.8" viewBox="0 0 24 24">
                        <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-white font-semibold text-sm">{formatRand(txn.amount)}</p>
                      <p className="text-slate-500 text-xs mt-0.5">{txn.referenceNumber}</p>
                      <p className="text-slate-600 text-xs">
                        {txn.disbursedAt
                          ? `Disbursed on ${formatDate(txn.disbursedAt)}`
                          : formatDate(txn.createdAt)
                        }
                      </p>
                    </div>
                  </div>
                  <span className={`${cfg.bg} ${cfg.text} text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`}/>
                    {cfg.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ════════ CONFIRMATION MODAL ════════ */}
      {modalState !== 'hidden' && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-sm p-6 shadow-2xl">

            {/* CONFIRM */}
            {modalState === 'confirm' && (
              <>
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
                  <svg width="26" height="26" fill="none" stroke="#4ade80" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                  </svg>
                </div>
                <h2 className="text-white font-black text-xl text-center mb-1">Confirm Withdrawal</h2>
                <p className="text-slate-400 text-sm text-center mb-5">Please review your transaction details</p>

                <div className="bg-slate-800 rounded-xl p-4 mb-5 space-y-2">
                  <div className="flex justify-between"><span className="text-slate-400 text-sm">You receive</span><span className="text-emerald-400 font-bold">{formatRand(withdrawAmount)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400 text-sm">To account</span><span className="text-white text-sm font-medium">{employee.bankName} {employee.bankAccountMasked}</span></div>
                  <div className="h-px bg-slate-700"/>
                  <div className="flex justify-between"><span className="text-slate-400 text-sm">Transaction fee</span><span className="text-amber-400 text-sm font-semibold">R{fee.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400 text-sm">Month-end deduction</span><span className="text-white text-sm font-bold">{formatRand(payrollDeduction)}</span></div>
                </div>

                <p className="text-slate-500 text-xs text-center mb-5">
                  {formatRand(payrollDeduction)} will be deducted from your June 2026 salary.
                </p>

                <div className="flex gap-3">
                  <button onClick={() => setModalState('hidden')} className="flex-1 py-3.5 rounded-xl font-semibold text-sm text-slate-300 border border-slate-700 hover:border-slate-500 transition-colors">
                    Cancel
                  </button>
                  <button onClick={handleConfirmWithdrawal} className="flex-1 py-3.5 rounded-xl font-bold text-sm text-white" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}>
                    Confirm & Send
                  </button>
                </div>
              </>
            )}

            {/* PROCESSING */}
            {modalState === 'processing' && (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4 animate-pulse">
                  <svg width="26" height="26" fill="none" stroke="#4ade80" strokeWidth="2" viewBox="0 0 24 24" className="animate-spin">
                    <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="15"/>
                  </svg>
                </div>
                <h2 className="text-white font-black text-xl mb-1">Processing…</h2>
                <p className="text-slate-400 text-sm">Sending {formatRand(withdrawAmount)} to your bank account</p>
              </div>
            )}

            {/* SUCCESS */}
            {modalState === 'success' && (
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center mx-auto mb-4 shadow-lg" style={{ boxShadow: '0 0 0 8px rgba(16,185,129,0.15)' }}>
                  <svg width="30" height="30" fill="none" stroke="#fff" strokeWidth="2.5" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <h2 className="text-white font-black text-xl mb-1">Money Sent! 🎉</h2>
                <p className="text-slate-400 text-sm mb-1">{formatRand(withdrawAmount)} is on its way to</p>
                <p className="text-emerald-400 font-semibold text-sm mb-5">{employee.bankName} {employee.bankAccountMasked}</p>
                <p className="text-slate-500 text-xs mb-6">Funds typically arrive within minutes. {formatRand(payrollDeduction)} will be deducted from your June 2026 salary.</p>
                <button onClick={() => setModalState('hidden')} className="w-full py-3.5 rounded-xl font-bold text-white" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}>
                  Done
                </button>
              </div>
            )}

            {/* ERROR */}
            {modalState === 'error' && (
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-red-500/20 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
                  <svg width="26" height="26" fill="none" stroke="#f87171" strokeWidth="2" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                </div>
                <h2 className="text-white font-black text-xl mb-1">Unable to Process</h2>
                <p className="text-slate-400 text-sm mb-5">{errorMessage}</p>
                <button onClick={() => setModalState('hidden')} className="w-full py-3.5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 transition-colors">
                  Go Back
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Slider custom styles */}
      <style>{`
        input[type=range]::-webkit-slider-thumb {
          appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #10b981;
          cursor: pointer;
          box-shadow: 0 0 0 4px rgba(16,185,129,0.2), 0 2px 8px rgba(0,0,0,0.4);
          transition: box-shadow 0.2s;
        }
        input[type=range]::-webkit-slider-thumb:hover {
          box-shadow: 0 0 0 7px rgba(16,185,129,0.25), 0 2px 8px rgba(0,0,0,0.4);
        }
        input[type=range]::-moz-range-thumb {
          width: 22px; height: 22px;
          border-radius: 50%;
          background: #10b981;
          cursor: pointer;
          border: none;
          box-shadow: 0 0 0 4px rgba(16,185,129,0.2);
        }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
      `}</style>
    </div>
  );
}
