import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';

const PENDING_INVITE_KEY = 'pendingInviteToken';
const STASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches server invite expiry)

export function savePendingInvite(token: string) {
  localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({
    token,
    ts: Date.now(),
  }));
}

/** Non-destructive read — returns the token if valid, null otherwise. */
export function peekPendingInvite(): string | null {
  const raw = localStorage.getItem(PENDING_INVITE_KEY);
  if (!raw) return null;
  try {
    const { token, ts } = JSON.parse(raw);
    if (Date.now() - ts > STASH_TTL_MS) {
      localStorage.removeItem(PENDING_INVITE_KEY);
      return null;
    }
    return token;
  } catch {
    localStorage.removeItem(PENDING_INVITE_KEY);
    return null;
  }
}

function clearPendingInvite() {
  localStorage.removeItem(PENDING_INVITE_KEY);
}

export function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (isLoading || !token) return;

    if (!user) {
      // Not logged in — stash the token and send to register
      savePendingInvite(token);
      navigate('/register', { replace: true });
      return;
    }

    // Logged in — accept the invite
    setJoining(true);
    apiFetch('/households/join/' + token, { method: 'POST' })
      .then(() => {
        clearPendingInvite();
        toast.success('Joined household!');
        navigate('/settings', { replace: true });
      })
      .catch((err: any) => {
        clearPendingInvite();
        setError(err.message || 'Failed to join household');
      })
      .finally(() => setJoining(false));
  }, [isLoading, user, token, navigate]);

  if (isLoading || joining) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">Joining household...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <div className="text-center max-w-sm">
          <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3 mb-4">
            {error}
          </p>
          <button
            onClick={() => navigate('/settings')}
            className="text-sm text-primary hover:text-primary/80 transition-colors"
          >
            Go to Settings
          </button>
        </div>
      </div>
    );
  }

  return null;
}
