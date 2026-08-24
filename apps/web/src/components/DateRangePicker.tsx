import { useState, useRef, useEffect } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import { format } from 'date-fns';
import { Calendar } from 'lucide-react';
import 'react-day-picker/style.css';

interface DateRangePickerProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export function DateRangePicker({ from, to, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected: DateRange = {
    from: from ? new Date(from + 'T00:00:00') : undefined,
    to: to ? new Date(to + 'T00:00:00') : undefined,
  };

  const handleSelect = (range: DateRange | undefined) => {
    const f = range?.from ? format(range.from, 'yyyy-MM-dd') : '';
    const t = range?.to ? format(range.to, 'yyyy-MM-dd') : '';
    onChange(f, t);
    if (range?.from && range?.to) {
      setTimeout(() => setOpen(false), 200);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const label = selected.from
    ? selected.to
      ? `${format(selected.from, 'MMM d, yyyy')} – ${format(selected.to, 'MMM d, yyyy')}`
      : `${format(selected.from, 'MMM d, yyyy')} – ...`
    : 'Select dates';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-lighter border border-border text-xs text-gray-200 hover:border-gray-500 transition-colors"
      >
        <Calendar size={13} className="text-gray-400" />
        {label}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 bg-surface-lighter border border-border rounded-xl shadow-xl shadow-black/40 p-3">
          <DayPicker
            mode="range"
            selected={selected}
            onSelect={handleSelect}
            numberOfMonths={1}
            showOutsideDays
            classNames={{
              root: 'rdp-dark',
              day: 'rdp-day-dark',
            }}
          />
        </div>
      )}
    </div>
  );
}
