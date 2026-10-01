'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const Ctx = createContext<(message: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ message: string; bad: boolean } | null>(null);
  const show = useCallback((message: string, bad = false) => setT({ message, bad }), []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), t.bad ? 7000 : 3500);
    return () => clearTimeout(id);
  }, [t]);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div role="status" aria-live="polite">
        {t ? <div className={`toast${t.bad ? ' bad' : ''}`}>{t.message}</div> : null}
      </div>
    </Ctx.Provider>
  );
}
