import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ledger_demo_mode';

let listeners: Array<() => void> = [];

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

function getSnapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function isDemoMode(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function demoText(text: string, mask = '••••'): string {
  return isDemoMode() ? mask : text;
}

export function useDemo() {
  const demoMode = useSyncExternalStore(subscribe, getSnapshot);

  const toggleDemoMode = () => {
    const next = !getSnapshot();
    if (next) {
      localStorage.setItem(STORAGE_KEY, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    emitChange();
  };

  return { isDemoMode: demoMode, toggleDemoMode };
}
