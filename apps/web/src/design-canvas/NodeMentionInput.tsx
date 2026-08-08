import { AtSign, Check, Search, X } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../components/ui/index.ts";
import { catalogItem } from "./catalog.ts";
import type { DesignNode } from "./types.ts";

const MAX_MENTION_RESULTS = 8;
const MAX_PRIORITY_NODES = 24;

export interface ActiveNodeMention {
  start: number;
  end: number;
  query: string;
}

export function activeNodeMention(value: string, caret: number | null): ActiveNodeMention | null {
  if (caret === null || caret < 1 || caret > value.length) return null;
  const beforeCaret = value.slice(0, caret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  const preceding = start === 0 ? "" : beforeCaret[start - 1]!;
  if (preceding && !/[\s([{]/.test(preceding)) return null;
  const rawQuery = beforeCaret.slice(start + 1);
  if (rawQuery.length > 80 || /[\n\r\]@]/.test(rawQuery)) return null;
  return { start, end: caret, query: rawQuery.trim().toLocaleLowerCase() };
}

export function matchingMentionNodes(
  nodes: readonly DesignNode[],
  query: string,
  excludedNodeId?: string,
): DesignNode[] {
  const prefix: DesignNode[] = [];
  const contains: DesignNode[] = [];
  for (const node of nodes) {
    if (node.id === excludedNodeId) continue;
    const name = node.name.toLocaleLowerCase();
    const kind = catalogItem(node.kind).label.toLocaleLowerCase();
    if (!query || name.startsWith(query) || kind.startsWith(query)) prefix.push(node);
    else if (name.includes(query) || kind.includes(query)) contains.push(node);
    if (prefix.length >= MAX_MENTION_RESULTS) break;
  }
  return [...prefix, ...contains].slice(0, MAX_MENTION_RESULTS);
}

export function NodeMentionInput({
  nodes,
  excludeNodeId,
  value,
  onChange,
  priorityNodeIds,
  onPriorityNodeIdsChange,
  ariaLabel,
  placeholder,
  onSubmitShortcut,
}: {
  nodes: readonly DesignNode[];
  excludeNodeId?: string;
  value: string;
  onChange: (value: string) => void;
  priorityNodeIds: readonly string[];
  onPriorityNodeIdsChange: (ids: string[]) => void;
  ariaLabel: string;
  placeholder: string;
  onSubmitShortcut: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const mentionListId = useId();
  const inputName = `${mentionListId.replace(/:/g, "")}-message`;
  const [caret, setCaret] = useState<number | null>(0);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const mention = activeNodeMention(value, caret);
  const matches = useMemo(
    () => matchingMentionNodes(nodes, mention?.query ?? "", excludeNodeId),
    [excludeNodeId, mention?.query, nodes],
  );
  const open = mention !== null && matches.length > 0 && !dismissed;
  useLayoutEffect(() => {
    const nextCaret = pendingCaretRef.current;
    if (nextCaret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
  }, [value]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const duplicatePositionById = useMemo(() => {
    const idsByName = new Map<string, string[]>();
    for (const node of nodes) {
      const key = node.name.trim().toLocaleLowerCase();
      const ids = idsByName.get(key);
      if (ids) ids.push(node.id);
      else idsByName.set(key, [node.id]);
    }
    const positions = new Map<string, { index: number; total: number }>();
    for (const ids of idsByName.values()) {
      if (ids.length < 2) continue;
      ids.forEach((id, index) => positions.set(id, { index: index + 1, total: ids.length }));
    }
    return positions;
  }, [nodes]);
  const selectedNodes = priorityNodeIds.flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(160, Math.max(62, textarea.scrollHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }, [selectedNodes.length, value]);

  const changeValue = (next: string, nextCaret: number | null) => {
    onChange(next);
    setCaret(nextCaret);
    setDismissed(false);
    setHighlightedIndex(0);
  };

  const chooseNode = (node: DesignNode) => {
    if (!mention) return;
    const prefix = value.slice(0, mention.start);
    const suffix = value.slice(mention.end);
    const nodeName = node.name.trim() || "Untitled Node";
    const spacing = suffix.startsWith(" ") || suffix.startsWith("\n") ? "" : " ";
    const next = `${prefix}${nodeName}${spacing}${suffix}`;
    const nextCaret = prefix.length + nodeName.length + spacing.length;
    onChange(next);
    if (!priorityNodeIds.includes(node.id) && priorityNodeIds.length < MAX_PRIORITY_NODES) {
      onPriorityNodeIdsChange([...priorityNodeIds, node.id]);
    }
    pendingCaretRef.current = nextCaret;
    setDismissed(true);
    setCaret(nextCaret);
  };

  const removeNode = (node: DesignNode) => {
    onPriorityNodeIdsChange(priorityNodeIds.filter((id) => id !== node.id));
    setDismissed(true);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setHighlightedIndex((current) => (current + direction + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseNode(matches[Math.min(highlightedIndex, matches.length - 1)]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onSubmitShortcut();
    }
  };

  return (
    <Popover open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) setDismissed(true);
    }} modal={false}>
      <PopoverAnchor asChild>
        <div className="design-canvas-agent__mention-anchor">
          {selectedNodes.length > 0 ? (
            <div className="design-canvas-agent__mentions" aria-label="Referenced Nodes">
              {selectedNodes.map((node) => (
                <span key={node.id} className="design-canvas-agent__mention-chip">
                  <AtSign aria-hidden />
                  <span>{node.name}</span>
                  <button type="button" aria-label={`Remove ${node.name} reference`} onClick={() => removeNode(node)}>
                    <X aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? mentionListId : undefined}
            aria-activedescendant={open ? `design-node-mention-${matches[Math.min(highlightedIndex, matches.length - 1)]!.id}` : undefined}
            name={inputName}
            autoComplete="off"
            value={value}
            rows={1}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(event) => changeValue(event.target.value, event.target.selectionStart)}
            onClick={(event) => {
              setCaret(event.currentTarget.selectionStart);
              setDismissed(false);
            }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        id={mentionListId}
        role="listbox"
        side="top"
        align="start"
        sideOffset={7}
        className="design-canvas-agent__mention-menu"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="design-canvas-agent__mention-menu-heading">
          <Search aria-hidden />
          <span>{mention?.query ? `Nodes matching “${mention.query}”` : "Reference a Node"}</span>
          <kbd>↵</kbd>
        </div>
        <div className="design-canvas-agent__mention-results">
          {matches.map((node, index) => {
            const selected = priorityNodeIds.includes(node.id);
            return (
              <button
                id={`design-node-mention-${node.id}`}
                key={node.id}
                type="button"
                role="option"
                aria-selected={selected}
                data-highlighted={index === highlightedIndex || undefined}
                className="design-canvas-agent__mention-result"
                onPointerMove={() => setHighlightedIndex(index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  chooseNode(node);
                }}
              >
                <span className="design-canvas-agent__mention-result-icon"><AtSign aria-hidden /></span>
                <span className="min-w-0">
                  <strong>{node.name}</strong>
                  <small>
                    {catalogItem(node.kind).label}
                    {duplicatePositionById.has(node.id)
                      ? ` · ${duplicatePositionById.get(node.id)!.index} of ${duplicatePositionById.get(node.id)!.total}`
                      : node.versionCount > 0 ? ` · v${node.versionCount}` : ""}
                  </small>
                </span>
                {selected ? <Check aria-hidden className="design-canvas-agent__mention-check" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
