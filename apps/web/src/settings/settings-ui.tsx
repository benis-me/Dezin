import type { ReactNode } from "react";

export function SettingsPanel({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div>
      <div className="border-b border-border pb-5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {desc ? <p className="mt-1 text-sm text-muted-foreground">{desc}</p> : null}
      </div>
      <div className="pt-5">{children}</div>
    </div>
  );
}

export function SettingsRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

export function SettingRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc ? <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
