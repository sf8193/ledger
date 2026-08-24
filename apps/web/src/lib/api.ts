const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

let activeHouseholdId: string | null = localStorage.getItem('activeHouseholdId');

export function setActiveHousehold(id: string) {
  activeHouseholdId = id;
  localStorage.setItem('activeHouseholdId', id);
}

export function clearActiveHousehold() {
  activeHouseholdId = null;
  localStorage.removeItem('activeHouseholdId');
}

export function getActiveHousehold(): string | null {
  return activeHouseholdId;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers as Record<string, string>,
  };

  if (activeHouseholdId) {
    headers['X-Household-Id'] = activeHouseholdId;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    // If we get 403 "Not a member" with a household header, clear it and retry without
    if (res.status === 403 && activeHouseholdId) {
      const body = await res.json().catch(() => ({}));
      if (body.error === 'Not a member of this household') {
        clearActiveHousehold();
        // Retry without the header
        return apiFetch<T>(path, options);
      }
      throw new Error(body.error || `API error: ${res.status}`);
    }

    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}
