import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

type Variant = "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  variant: Variant;
}

interface ToastApi {
  toast: (message: string, opts?: { variant?: Variant }) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const remove = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (message: string, opts?: { variant?: Variant }) => {
      const id = idRef.current++;
      setItems((x) => [...x, { id, message, variant: opts?.variant ?? "info" }]);
      const h = setTimeout(() => {
        timers.current.delete(h);
        remove(id);
      }, 4000);
      timers.current.add(h);
    },
    [remove],
  );

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const h of set) clearTimeout(h);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start justify-between gap-2 rounded-md border bg-surface px-3 py-2 text-sm shadow-md ${
              t.variant === "error" ? "border-destructive text-destructive" : "border-border text-foreground"
            }`}
          >
            <span>{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => remove(t.id)}
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
