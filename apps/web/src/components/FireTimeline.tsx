import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { TimelineEvent } from '../lib/fire/engine';
import { isDemoMode } from '../hooks/useDemo';

interface Preset {
  label: string;
  type: TimelineEvent['type'];
  defaultAmount: number;
  defaultEndAge?: number;
  description: string;
}

const PRESETS: Preset[] = [
  { label: 'Income change', type: 'income_change', defaultAmount: -50000, description: 'Raise, cut, one income, job change' },
  { label: 'Mortgage paid off', type: 'expense_reduction', defaultAmount: -30000, description: 'Remove housing payment' },
  { label: 'Childcare', type: 'expense_temporary', defaultAmount: 24000, defaultEndAge: 5, description: 'Temporary expense' },
  { label: 'Kids college', type: 'expense_temporary', defaultAmount: 40000, defaultEndAge: 4, description: '4 years of tuition' },
  { label: 'Inheritance', type: 'one_time', defaultAmount: 200000, description: 'One-time portfolio boost' },
  { label: 'Part-time income', type: 'income', defaultAmount: 30000, description: 'Post-retirement income' },
  { label: 'Rental income', type: 'income', defaultAmount: 18000, description: 'Ongoing passive income' },
  { label: 'Pension', type: 'income', defaultAmount: 24000, description: 'Starts at a specific age' },
  { label: 'Move to lower COL', type: 'expense_reduction', defaultAmount: -20000, description: 'Reduce annual spending' },
];

const TYPE_LABELS: Record<TimelineEvent['type'], { label: string; color: string }> = {
  income: { label: 'Income', color: 'text-emerald-400' },
  income_change: { label: 'Income Δ', color: 'text-amber-400' },
  expense_reduction: { label: 'Expense Δ', color: 'text-blue-400' },
  expense_temporary: { label: 'Temporary', color: 'text-purple-400' },
  one_time: { label: 'One-time', color: 'text-cyan-400' },
};

export function FireTimeline({ events, onChange, currentAge }: {
  events: TimelineEvent[];
  onChange: (events: TimelineEvent[]) => void;
  currentAge: number;
}) {
  const [showAdd, setShowAdd] = useState(false);

  const addEvent = (preset: Preset) => {
    const newEvent: TimelineEvent = {
      id: `evt-${Date.now()}`,
      label: preset.label,
      age: preset.type === 'income' ? currentAge + 25 : currentAge + 10,
      annualAmount: preset.defaultAmount,
      type: preset.type,
      ...(preset.type === 'expense_temporary' && {
        endAge: (preset.type === 'expense_temporary' ? currentAge + 10 : currentAge + 10) + (preset.defaultEndAge ?? 5),
      }),
    };
    onChange([...events, newEvent]);
    setShowAdd(false);
  };

  const addCustom = () => {
    onChange([...events, {
      id: `evt-${Date.now()}`,
      label: 'Custom event',
      age: currentAge + 10,
      annualAmount: 0,
      type: 'expense_reduction',
    }]);
    setShowAdd(false);
  };

  const updateEvent = (id: string, updates: Partial<TimelineEvent>) => {
    onChange(events.map(e => e.id === id ? { ...e, ...updates } : e));
  };

  const removeEvent = (id: string) => {
    onChange(events.filter(e => e.id !== id));
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-white">Life Events</h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {events.length === 0 && !showAdd && (
        <p className="text-xs text-slate-600">Model income changes, expense shifts, windfalls, and life transitions.</p>
      )}

      {/* Event list */}
      <div className="space-y-2">
        {events.sort((a, b) => a.age - b.age).map(event => {
          const typeInfo = TYPE_LABELS[event.type];
          return (
            <div key={event.id} className="flex items-center gap-2 bg-surface-lighter rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={event.label}
                    onChange={e => updateEvent(event.id, { label: e.target.value })}
                    className="bg-transparent text-sm text-white flex-1 focus:outline-none min-w-0"
                    aria-label="Event name"
                  />
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeInfo.color} bg-white/5 shrink-0`}>
                    {typeInfo.label}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <label className="flex items-center gap-1 text-[11px] text-slate-500">
                    Age
                    <input
                      type="number"
                      value={event.age}
                      onChange={e => updateEvent(event.id, { age: Number(e.target.value) })}
                      onFocus={e => e.target.select()}
                      min={currentAge}
                      max={100}
                      className="w-12 bg-transparent border-b border-border text-white text-[11px] focus:outline-none focus:border-primary/50 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </label>
                  {event.type === 'expense_temporary' && (
                    <label className="flex items-center gap-1 text-[11px] text-slate-500">
                      to
                      <input
                        type="number"
                        value={event.endAge ?? event.age + 5}
                        onChange={e => updateEvent(event.id, { endAge: Number(e.target.value) })}
                        onFocus={e => e.target.select()}
                        min={event.age + 1}
                        max={100}
                        className="w-12 bg-transparent border-b border-border text-white text-[11px] focus:outline-none focus:border-primary/50 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </label>
                  )}
                  <label className="flex items-center gap-1 text-[11px] text-slate-500">
                    {event.type === 'one_time' ? '$' : '$/yr'}
                    {isDemoMode() ? (
                      <span className="w-20 text-center text-[11px] text-slate-500">••••</span>
                    ) : (
                      <input
                        type="number"
                        value={event.annualAmount}
                        onChange={e => updateEvent(event.id, { annualAmount: Number(e.target.value) })}
                        onFocus={e => e.target.select()}
                        step={1000}
                        className="w-20 bg-transparent border-b border-border text-white text-[11px] focus:outline-none focus:border-primary/50 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    )}
                  </label>
                  <select
                    value={event.type}
                    onChange={e => updateEvent(event.id, { type: e.target.value as TimelineEvent['type'] })}
                    className="bg-transparent text-[11px] text-slate-500 focus:outline-none"
                    aria-label="Event type"
                  >
                    <option value="income_change">Income change</option>
                    <option value="expense_reduction">Expense change</option>
                    <option value="expense_temporary">Temporary expense</option>
                    <option value="income">Retirement income</option>
                    <option value="one_time">One-time</option>
                  </select>
                </div>
              </div>
              <button
                onClick={() => removeEvent(event.id)}
                className="text-slate-600 hover:text-red-400 transition-colors p-1"
                aria-label={`Remove ${event.label}`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add preset panel */}
      {showAdd && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {PRESETS.map(preset => (
            <button
              key={preset.label}
              onClick={() => addEvent(preset)}
              className="text-left px-2.5 py-2 rounded-lg bg-surface-lighter hover:bg-white/5 text-slate-400 hover:text-white transition-colors"
            >
              <div className="text-xs">{preset.label}</div>
              <div className="text-[10px] text-slate-600">{preset.description}</div>
            </button>
          ))}
          <button
            onClick={addCustom}
            className="text-left px-2.5 py-2 rounded-lg bg-surface-lighter hover:bg-white/5 text-slate-400 hover:text-white transition-colors col-span-2"
          >
            <div className="text-xs">+ Custom event</div>
          </button>
        </div>
      )}
    </div>
  );
}
