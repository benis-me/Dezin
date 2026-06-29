import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/index.ts";

export interface FieldOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string;
}

/**
 * A two-line "label over value" selector with a chevron — matches DesignSystemSelect,
 * so the composer's pickers (Template, Mode, …) share one form.
 */
export function FieldSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: FieldOption<T>[];
  onChange: (v: T) => void;
}) {
  const current = options.find((o) => o.value === value);
  const hasDesc = options.some((o) => o.description);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:border-border-strong"
      >
        {current?.icon ? <span className="shrink-0 text-muted-foreground">{current.icon}</span> : null}
        <span className="min-w-0">
          <span className="label-mono block leading-none">{label}</span>
          <span className="mt-0.5 block max-w-[10rem] truncate text-sm font-medium leading-tight">{current?.label ?? "Select"}</span>
        </span>
        <ChevronDown size={15} strokeWidth={2} className="ml-1 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={hasDesc ? "w-72" : "w-52"}>
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onChange(o.value)} className="items-start gap-2.5">
            {o.icon ? <span className="mt-0.5 text-muted-foreground">{o.icon}</span> : null}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium leading-tight">{o.label}</span>
              {o.description ? <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{o.description}</span> : null}
            </span>
            {o.value === value ? <Check size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-foreground" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
