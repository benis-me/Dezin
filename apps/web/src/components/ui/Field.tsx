import type { ReactNode } from "react";
import { Label } from "./label.tsx";

/** Label + control + optional hint, vertically stacked. */
export function Field({ label, hint, htmlFor, children }: { label?: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label ? <Label htmlFor={htmlFor}>{label}</Label> : null}
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
