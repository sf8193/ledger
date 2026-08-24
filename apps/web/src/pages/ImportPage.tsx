import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { Upload, FileText, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';

interface ImportResult {
  accounts_created?: number;
  categories_created?: number;
  transactions_imported?: number;
  transactions_skipped?: number;
  snapshots_imported?: number;
  snapshots_skipped?: number;
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const balanceFileInputRef = useRef<HTMLInputElement>(null);

  const handleFileImport = async (file: File, endpoint: string) => {
    setImporting(true);
    setResult(null);
    setError(null);

    try {
      const text = await file.text();
      const res = await apiFetch<ImportResult>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ csv: text }),
      });
      setResult(res);
      toast.success('Import complete');
      queryClient.invalidateQueries();
    } catch (err: any) {
      setError(err.message || 'Import failed');
      toast.error('Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Import</h1>
        <p className="text-sm text-slate-500 mt-1">Import data from Monarch or other sources</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Transactions import */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <FileText size={20} className="text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-white">Monarch Transactions</h3>
              <p className="text-xs text-slate-500">Import transactions CSV from Monarch</p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileImport(file, '/import/monarch/transactions');
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-border hover:border-primary/50 text-slate-400 hover:text-primary text-sm transition-colors disabled:opacity-50"
          >
            <Upload size={16} />
            {importing ? 'Importing...' : 'Choose CSV file'}
          </button>
        </div>

        {/* Balances import */}
        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
              <FileText size={20} className="text-accent" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-white">Monarch Balances</h3>
              <p className="text-xs text-slate-500">Import account balance history for net worth chart</p>
            </div>
          </div>
          <input
            ref={balanceFileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileImport(file, '/import/monarch/balances');
              e.target.value = '';
            }}
          />
          <button
            onClick={() => balanceFileInputRef.current?.click()}
            disabled={importing}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-border hover:border-accent/50 text-slate-400 hover:text-accent text-sm transition-colors disabled:opacity-50"
          >
            <Upload size={16} />
            {importing ? 'Importing...' : 'Choose CSV file'}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="card p-5 animate-fade-in">
          <div className="flex items-center gap-3 mb-3">
            <CheckCircle2 size={20} className="text-emerald-400" />
            <h3 className="text-sm font-medium text-white">Import Complete</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {result.accounts_created !== undefined && (
              <div className="card-inset px-3 py-2">
                <div className="text-lg font-semibold text-white tabular-nums">{result.accounts_created}</div>
                <div className="text-xs text-slate-500">Accounts created</div>
              </div>
            )}
            {result.categories_created !== undefined && (
              <div className="card-inset px-3 py-2">
                <div className="text-lg font-semibold text-white tabular-nums">{result.categories_created}</div>
                <div className="text-xs text-slate-500">Categories created</div>
              </div>
            )}
            {result.transactions_imported !== undefined && (
              <div className="card-inset px-3 py-2">
                <div className="text-lg font-semibold text-white tabular-nums">{result.transactions_imported}</div>
                <div className="text-xs text-slate-500">Transactions imported</div>
              </div>
            )}
            {result.transactions_skipped !== undefined && result.transactions_skipped > 0 && (
              <div className="card-inset px-3 py-2">
                <div className="text-lg font-semibold text-slate-400 tabular-nums">{result.transactions_skipped}</div>
                <div className="text-xs text-slate-500">Skipped (duplicates)</div>
              </div>
            )}
            {result.snapshots_imported !== undefined && (
              <div className="card-inset px-3 py-2">
                <div className="text-lg font-semibold text-white tabular-nums">{result.snapshots_imported}</div>
                <div className="text-xs text-slate-500">Snapshots imported</div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 mt-4">
            <Link to="/" className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors">
              Review transactions <ArrowRight size={12} />
            </Link>
            <Link to="/accounts" className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors">
              View accounts <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      )}

      {error && (
        <div className="card p-5 border-red-500/30 animate-fade-in">
          <div className="flex items-center gap-3">
            <AlertCircle size={20} className="text-red-400" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
