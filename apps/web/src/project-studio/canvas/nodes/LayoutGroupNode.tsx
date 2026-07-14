import { NodeResizer, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight, Frame, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function LayoutGroupNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const editSessionRef = useRef(false);

  useEffect(() => setLabel(data.name), [data.name]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
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
    <div className="dezin-flow-group" data-selected={selected || undefined} data-collapsed={data.collapsed || undefined}>
      <NodeResizer
        isVisible={selected}
        minWidth={240}
        minHeight={144}
        lineClassName="dezin-flow-group__resize-line"
        handleClassName="dezin-flow-group__resize-handle"
        onResizeEnd={(_event, parameters) => data.onResizeGroup?.(data.objectId, parameters)}
      />
      <div className="dezin-flow-group__header">
        <Frame size={12} aria-hidden />
        {editing ? (
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
          <button type="button" className="nodrag nopan dezin-flow-group__label" onClick={startRename} aria-label={`Rename group ${data.name}`}>
            {data.name}<Pencil size={10} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="nodrag nopan dezin-flow-group__collapse"
          aria-label={`${data.collapsed ? "Expand" : "Collapse"} group ${data.name}`}
          aria-expanded={!data.collapsed}
          onClick={() => data.onToggleCollapsed?.(data.objectId, !data.collapsed)}
        >
          {data.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
    </div>
  );
}
