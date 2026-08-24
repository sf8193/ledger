import { RefreshCw, AlertTriangle } from 'lucide-react';

export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card px-5 py-8 text-center animate-fade-in">
      <AlertTriangle size={24} className="text-amber-400 mx-auto mb-2" />
      <p className="text-sm text-white">Something went wrong</p>
      <p className="text-xs text-slate-500 mt-1">{message}</p>
      <button
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors"
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card divide-y divide-border">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-surface-lighter animate-pulse" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-32 bg-surface-lighter rounded animate-pulse" />
              <div className="h-3 w-20 bg-surface-lighter rounded animate-pulse" />
            </div>
          </div>
          <div className="h-4 w-16 bg-surface-lighter rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
