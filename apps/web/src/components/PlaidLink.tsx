import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { apiFetch } from '../lib/api';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';

interface PlaidLinkButtonProps {
  onSuccess: () => void;
}

export function PlaidLinkButton({ onSuccess }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const getLinkToken = useCallback(async () => {
    setLoading(true);
    try {
      const { link_token } = await apiFetch<{ link_token: string }>('/plaid/link-token', {
        method: 'POST',
      });
      setLinkToken(link_token);
    } catch {
      toast.error('Failed to create link token');
      setLoading(false);
    }
  }, []);

  return linkToken ? (
    <PlaidLinkOpener
      linkToken={linkToken}
      onSuccess={() => {
        setLinkToken(null);
        setLoading(false);
        onSuccess();
      }}
      onExit={() => {
        setLinkToken(null);
        setLoading(false);
      }}
    />
  ) : (
    <button
      onClick={getLinkToken}
      disabled={loading}
      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
    >
      <Link2 size={16} />
      {loading ? 'Connecting...' : 'Connect a Bank'}
    </button>
  );
}

function PlaidLinkOpener({
  linkToken,
  onSuccess,
  onExit,
}: {
  linkToken: string;
  onSuccess: () => void;
  onExit: () => void;
}) {
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      console.log('[PlaidLink] full metadata:', JSON.stringify(metadata, null, 2));
      try {
        const result = await apiFetch<{ item_id: string; accounts: number }>('/plaid/exchange', {
          method: 'POST',
          body: JSON.stringify({
            public_token: publicToken,
            institution: metadata.institution,
            accounts: metadata.accounts?.map(a => ({
              id: a.id,
              name: a.name,
              mask: a.mask,
            })),
          }),
        });
        toast.success(`Connected! ${result.accounts} account${result.accounts !== 1 ? 's' : ''} linked.`);
        onSuccess();
      } catch {
        toast.error('Failed to link account');
        onExit();
      }
    },
    onExit: () => {
      onExit();
    },
  });

  // Auto-open when ready
  useEffect(() => {
    if (ready) {
      open();
    }
  }, [ready, open]);

  return (
    <button
      disabled
      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface border border-border text-gray-400 text-sm"
    >
      <Link2 size={16} />
      Opening Plaid...
    </button>
  );
}
