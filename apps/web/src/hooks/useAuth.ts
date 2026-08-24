import { useSession } from '../lib/auth-client';

export function useAuth() {
  const { data: session, isPending, error } = useSession();
  const user = session?.user ?? null;

  return {
    user,
    isLoading: isPending,
    isAuthenticated: !!user,
    error,
  };
}
