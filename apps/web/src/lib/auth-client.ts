import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/api/auth`
    : `${window.location.origin}/api/auth`,
});

export const { signIn, signUp, signOut, useSession } = authClient;
