import { NodeResizer, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight, Component, Frame, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function LayoutGroupNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const componentLibrary = data.groupRole === "component-library";
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const editSessionRef = useRef(false);

  useEffect(() => setLabel(data.name), [data.name]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    if (componentLibrary) return;
    editSessionRef.current = true;
    setEditing(true);
  };
  const finishRename = () => {
    if (!editSessionRef.current) return;
    editSessionRef.current = false;
    const next = label.trim();
    setEditing(false);
    if (next && next !== data.name) data.onRenameGroup?.(data.objectId, next);
    setLabel(data.name);
  };
  const cancelRename = () => {
    editSessionRef.current = false;
    setLabel(data.name);
    setEditing(false);
  };

  return (
    <div
      className="dezin-flow-group"
      data-selected={selected || undefined}
      data-collapsed={data.collapsed || undefined}
      data-role={data.groupRole ?? undefined}
      role="group"
      aria-label={componentLibrary
        ? `Shared components group, ${data.memberCount} ${data.memberCount === 1 ? "component" : "components"}`
        : `Group ${data.name}`}
    >
      <NodeResizer
        isVisible={selected && !data.collapsed}
        minWidth={data.minimumGroupWidth}
        minHeight={data.minimumGroupHeight}
        lineClassName="dezin-flow-group__resize-line"
        handleClassName="dezin-flow-group__resize-handle"
        onResizeEnd={(_event, parameters) => data.onResizeGroup?.(data.objectId, parameters)}
      />
      <NodeToolbar
        isVisible={selected || editing}
        position={Position.Top}
        align="start"
        offset={10}
        className="nodrag nopan nowheel dezin-flow-group__toolbar"
        role="toolbar"
        aria-label={`Group actions for ${data.name}`}
      >
        {!componentLibrary && (editing ? (
          <input
            ref={inputRef}
            className="nodrag nopan nowheel dezin-flow-group__input"
            aria-label={`Rename group ${data.name}`}
            name={`group-${data.objectId}-label`}
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                finishRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="nodrag nopan dezin-flow-group__toolbar-action"
            onClick={startRename}
            aria-label={`Rename group ${data.name}`}
          >
            <Pencil size={13} aria-hidden />
            <span>Rename</span>
          </button>
        ))}
        <button
          type="button"
          className="nodrag nopan dezin-flow-group__toolbar-action"
          aria-label={`${data.collapsed ? "Expand" : "Collapse"} group ${data.name}`}
          aria-expanded={!data.collapsed}
          onClick={() => data.onToggleCollapsed?.(data.objectId, !data.collapsed)}
        >
          {data.collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          <span>{data.collapsed ? "Expand" : "Collapse"}</span>
        </button>
      </NodeToolbar>
      <div className="dezin-flow-group__header">
        {componentLibrary ? (
          <span className="dezin-flow-group__system-icon" aria-hidden>
            <Component size={13} strokeWidth={1.55} />
          </span>
        ) : <Frame size={12} aria-hidden />}
        {componentLibrary ? (
          <span className="dezin-flow-group__system-label">
            <strong>Shared components</strong>
            <small>{data.memberCount} {data.memberCount === 1 ? "component" : "components"}</small>
          </span>
        ) : (
          <span className="dezin-flow-group__name" title={data.name}>{data.name}</span>
        )}
        {data.collapsed ? <ChevronRight className="dezin-flow-group__collapsed-indicator" size={13} aria-hidden /> : null}
      </div>
    </div>
  );
}
