import {
  ArrowLeft,
  Bot,
  Code2,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import {
  Button,
  IconSwap,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { StudioToolbarHeader } from "../components/ui/StudioHeader.tsx";

export function DesignCanvasHeader({
  projectName,
  onRenameProject,
  onBackHome,
  canvasAvailable,
  mainAgentOpen,
  onToggleMainAgent,
  exportTitle,
  exporting,
  exportDisabled,
  exportButtonRef,
  onExport,
  onOpenSettings,
}: {
  projectName: string;
  onRenameProject?: (name: string) => Promise<void>;
  onBackHome?: () => void;
  canvasAvailable: boolean;
  mainAgentOpen: boolean;
  onToggleMainAgent: () => void;
  exportTitle: string;
  exporting: boolean;
  exportDisabled: boolean;
  exportButtonRef?: Ref<HTMLButtonElement>;
  onExport: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <StudioToolbarHeader className="design-canvas-topbar app-drag">
      <TooltipProvider delayDuration={120}>
        <div className="app-no-drag design-canvas-topbar__leading">
          {onBackHome ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Back to projects" onClick={onBackHome}><ArrowLeft aria-hidden /></Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>Back to projects</TooltipContent>
              </Tooltip>
              <span className="design-canvas-topbar__divider" aria-hidden />
            </>
          ) : null}
          <div className="design-canvas-topbar__identity">
            <EditableProjectName name={projectName} onRename={onRenameProject} />
          </div>
        </div>
        <div className="app-no-drag design-canvas-topbar__actions" role="toolbar" aria-label="Project actions">
          <HeaderIconAction
            label="Main Agent"
            active={mainAgentOpen}
            disabled={!canvasAvailable}
            onClick={onToggleMainAgent}
          >
            <Bot aria-hidden />
          </HeaderIconAction>
          <HeaderIconAction
            label="Export code"
            tooltip={exportTitle}
            disabled={exportDisabled}
            buttonRef={exportButtonRef}
            onClick={onExport}
          >
            <IconSwap
              active={exporting}
              first={<Code2 aria-hidden />}
              second={<LoaderCircle aria-hidden className="animate-spin" />}
            />
          </HeaderIconAction>
          <HeaderIconAction label="Settings" disabled={!onOpenSettings} onClick={() => onOpenSettings?.()}>
            <Settings2 aria-hidden />
          </HeaderIconAction>
        </div>
      </TooltipProvider>
    </StudioToolbarHeader>
  );
}

function EditableProjectName({
  name,
  onRename,
}: {
  name: string;
  onRename?: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [displayName, setDisplayName] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setDisplayName(name);
    setValue(name);
  }, [name]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const nextName = value.trim();
    if (!nextName || nextName === displayName || !onRename) {
      setValue(displayName);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(nextName);
      setDisplayName(nextName);
      setValue(nextName);
    } catch {
      setValue(displayName);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }, [displayName, onRename, value]);

  return (
    <h1 className="design-canvas-topbar__project-name" title={displayName} data-editing={editing || undefined}>
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Project name"
          value={value}
          maxLength={160}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelledRef.current = true;
              setValue(displayName);
              setEditing(false);
            }
          }}
        />
      ) : onRename ? (
        <button
          type="button"
          aria-label={`Rename project: ${displayName}`}
          title="Rename project"
          onClick={() => {
            cancelledRef.current = false;
            setValue(displayName);
            setEditing(true);
          }}
        >
          {displayName}
        </button>
      ) : displayName}
    </h1>
  );
}

function HeaderIconAction({
  label,
  tooltip = label,
  active,
  disabled = false,
  buttonRef,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  active?: boolean;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="design-canvas-topbar__action-trigger" tabIndex={disabled ? 0 : undefined}>
          <Button
            ref={buttonRef}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            className="design-canvas-topbar__icon-action"
            aria-label={label}
            aria-pressed={active === undefined ? undefined : active}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
