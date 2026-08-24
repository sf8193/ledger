import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, setActiveHousehold, getActiveHousehold } from '../lib/api';
import { Settings, Link2, Trash2, RefreshCw, Users, Copy, Check, EyeOff } from 'lucide-react';
import { PlaidLinkButton } from '../components/PlaidLink';
import { toast } from 'sonner';
import { useState } from 'react';
import { useDemo } from '../hooks/useDemo';

interface PlaidStatus {
  configured: boolean;
}

interface PlaidItem {
  id: string;
  institution_name: string | null;
  status: string;
  last_synced: string | null;
}

interface Household {
  id: string;
  name: string;
  role: string;
  joined_at: string;
}

interface HouseholdMember {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  joined_at: string;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { isDemoMode, toggleDemoMode } = useDemo();

  const { data: households } = useQuery<Household[]>({
    queryKey: ['households'],
    queryFn: () => apiFetch('/households'),
  });

  const activeId = getActiveHousehold() || households?.[0]?.id;
  const activeHousehold = households?.find(h => h.id === activeId) || households?.[0];

  const { data: members } = useQuery<HouseholdMember[]>({
    queryKey: ['household-members', activeHousehold?.id],
    queryFn: () => apiFetch(`/households/${activeHousehold!.id}/members`),
    enabled: !!activeHousehold,
  });

  const { data: plaidStatus } = useQuery<PlaidStatus>({
    queryKey: ['plaid-status'],
    queryFn: () => apiFetch('/plaid/status'),
  });

  const { data: plaidItems } = useQuery<PlaidItem[]>({
    queryKey: ['plaid-items'],
    queryFn: () => apiFetch('/plaid/items'),
    enabled: !!plaidStatus?.configured,
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await apiFetch<{ items_synced: number; transactions_added: number }>('/plaid/sync', {
        method: 'POST',
      });
      toast.success(`Synced ${result.items_synced} item${result.items_synced !== 1 ? 's' : ''} — ${result.transactions_added} new transactions`);
      queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch {
      toast.error('Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!confirm('This will remove this connection and delete all synced transactions. Accounts with manual entries will be kept but unlinked. You can reconnect afterward to re-sync. Continue?')) {
      return;
    }
    try {
      await apiFetch(`/plaid/${itemId}`, { method: 'DELETE' });
      toast.success('Institution removed');
      queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch {
      toast.error('Failed to remove institution');
    }
  };

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const handleSwitchHousehold = (id: string) => {
    setActiveHousehold(id);
    // Invalidate everything so all data reloads for the new household
    queryClient.invalidateQueries();
    toast.success('Switched household');
  };

  const handleInvite = async () => {
    if (!inviteEmail || !activeHousehold) return;
    try {
      const result = await apiFetch<{ token: string }>(`/households/${activeHousehold.id}/invites`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail, role: 'member' }),
      });
      setInviteToken(result.token);
      setInviteEmail('');
      toast.success('Invite created');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create invite');
    }
  };

  const inviteLink = inviteToken
    ? `${window.location.origin}/join/${inviteToken}`
    : null;

  const handleCopyLink = () => {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };


  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-6">Settings</h2>

      <div className="space-y-4">
        {/* Household */}
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center gap-3 mb-4">
            <Users size={18} className="text-gray-500" />
            <h3 className="text-sm font-medium text-white">Household</h3>
          </div>

          {/* Switcher (only if multiple) */}
          {households && households.length > 1 && (
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Active household</label>
              <div className="flex gap-2">
                {households.map(h => (
                  <button
                    key={h.id}
                    onClick={() => handleSwitchHousehold(h.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      h.id === activeId
                        ? 'bg-primary/15 text-primary border border-primary/30'
                        : 'bg-background border border-border text-gray-400 hover:text-white hover:border-gray-600'
                    }`}
                  >
                    {h.name}
                    <span className="text-xs ml-1 opacity-60">({h.role})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Members */}
          {members && members.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Members</label>
              <div className="space-y-1">
                {members.map(m => (
                  <div key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-background border border-border min-w-0">
                    <div className="min-w-0">
                      <span className="text-sm text-white">{m.name}</span>
                      <span className="text-xs text-gray-500 ml-2 truncate">{m.email}</span>
                    </div>
                    <span className="text-xs text-gray-500 capitalize shrink-0">{m.role}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Invite (owner only) */}
          {activeHousehold?.role === 'owner' && (
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Invite someone</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="min-w-0 flex-1 px-3 py-2 rounded-lg bg-background border border-border text-white text-sm placeholder-slate-600"
                />
                <button
                  onClick={handleInvite}
                  disabled={!inviteEmail}
                  className="shrink-0 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  Invite
                </button>
              </div>
              {inviteLink && (
                <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border min-w-0">
                  <code className="text-xs text-emerald-400 flex-1 min-w-0 truncate">{inviteLink}</code>
                  <button onClick={handleCopyLink} className="shrink-0 text-gray-400 hover:text-white transition-colors">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Bank Connections */}
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Link2 size={18} className="text-gray-500" />
              <h3 className="text-sm font-medium text-white">Bank Connections</h3>
            </div>
            {plaidStatus?.configured && plaidItems && plaidItems.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-surface-lighter transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                  {syncing ? 'Syncing...' : 'Sync All'}
                </button>
                <PlaidLinkButton onSuccess={refreshAll} />
              </div>
            )}
          </div>

          {!plaidStatus?.configured ? (
            <p className="text-sm text-gray-500">
              Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to your .env file to enable bank syncing.
            </p>
          ) : plaidItems && plaidItems.length > 0 ? (
            <div className="space-y-2">
              {plaidItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between px-4 py-3 rounded-lg bg-background border border-border">
                  <div>
                    <div className="text-sm text-white">{item.institution_name || 'Unknown Institution'}</div>
                    <div className="text-xs text-gray-500">
                      {item.last_synced
                        ? `Last synced: ${new Date(item.last_synced).toLocaleString()}`
                        : 'Never synced'}
                      {' · '}
                      <span className={item.status === 'active' ? 'text-emerald-400' : 'text-red-400'}>
                        {item.status}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveItem(item.id)}
                    className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                    title="Remove institution"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-gray-500 mb-3">No banks connected yet.</p>
              <PlaidLinkButton onSuccess={refreshAll} />
            </div>
          )}

        </div>

        {/* General Settings */}
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center gap-3 mb-4">
            <Settings size={18} className="text-gray-500" />
            <h3 className="text-sm font-medium text-white">General</h3>
          </div>

          <div className="flex items-center justify-between px-3 py-3 rounded-lg bg-background border border-border">
            <div className="flex items-center gap-3">
              <EyeOff size={16} className="text-gray-500" />
              <div>
                <div className="text-sm text-white">Demo mode</div>
                <div className="text-xs text-gray-500">Hide all amounts for screenshots and presentations</div>
              </div>
            </div>
            <button
              onClick={toggleDemoMode}
              className={`relative w-10 h-5 rounded-full transition-colors ${isDemoMode ? 'bg-primary' : 'bg-gray-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isDemoMode ? 'translate-x-5' : ''}`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
