import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, ChevronLeft, Sparkles } from "lucide-react";
import type { EffectDetail, EffectParamValue } from "../lib/api.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/index.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { persistAgentModelDefaults } from "../lib/agent-model-defaults.ts";
import { cn } from "../lib/utils.ts";
import type { EffectValues } from "./effect-renderer.ts";

type EffectAgentMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

const FLOATING_COMPOSER_FADE_PX = 48;
const SCROLL_TO_BOTTOM_GAP_PX = 12;
const MESSAGE_BOTTOM_CLEARANCE_PX = 44;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value: EffectParamValue | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tuneValues(effect: EffectDetail, values: EffectValues, prompt: string): { values: EffectValues; changed: string[] } {
  const lower = prompt.toLowerCase();
  const next = { ...values };
  const changed: string[] = [];
  const wantsMore = /(more|stronger|increase|brighter|denser|richer|faster|heavier|bolder|更|加强|增加|更强|更亮)/i.test(prompt);
  const wantsLess = /(less|softer|reduce|subtle|slower|lighter|calmer|降低|减少|更柔|克制)/i.test(prompt);
  const colorHint = lower.includes("warm") || prompt.includes("暖") ? "#f2a65a" : lower.includes("cold") || lower.includes("cool") || prompt.includes("冷") ? "#6fb7ff" : null;

  for (const param of effect.parameters) {
    if (param.type === "number") {
      const min = typeof param.min === "number" ? param.min : 0;
      const max = typeof param.max === "number" ? param.max : 1;
      const current = numberValue(next[param.id], numberValue(param.defaultValue, min));
      const span = max - min || 1;
      if (wantsMore || lower.includes(param.id.toLowerCase()) || lower.includes(param.label.toLowerCase())) {
        next[param.id] = clamp(current + span * 0.16, min, max);
        changed.push(param.label);
      } else if (wantsLess) {
        next[param.id] = clamp(current - span * 0.16, min, max);
        changed.push(param.label);
      }
    }
    if (param.type === "color" && colorHint && /color|front|accent|highlight|paper|back|色|颜色|暖|冷/i.test(`${param.id} ${param.label} ${prompt}`)) {
      next[param.id] = colorHint;
      changed.push(param.label);
    }
  }

  return { values: next, changed: [...new Set(changed)].slice(0, 5) };
}

export function EffectAgentPanel({
  effect,
  values,
  onValuesChange,
  onBack,
}: {
  effect: EffectDetail;
  values: EffectValues;
  onValuesChange: (values: EffectValues) => void;
  onBack: () => void;
}) {
  const api = useApi();
  const { agents, rescan: rescanAgents } = useAgents();
  const [messages, setMessages] = useState<EffectAgentMessage[]>([]);
  const [text, setText] = useState("");
  const [nextId, setNextId] = useState(2);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null);
  const [settingsModel, setSettingsModel] = useState("");
  const [composerH, setComposerH] = useState(92);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composerOverlayH = composerH + FLOATING_COMPOSER_FADE_PX;
  const messageBottomPadding = composerOverlayH + MESSAGE_BOTTOM_CLEARANCE_PX;
  const scrollToBottomBottom = composerOverlayH + SCROLL_TO_BOTTOM_GAP_PX;
  const hasConversationContent = messages.length > 0;
  const emptyText =
    effect.origin === "custom"
      ? "Describe the shader behavior, uniforms, or controls you want. The Agent can reshape code and parameters from here."
      : "Describe the texture, motion, color, or image treatment you want. The Agent will tune the exposed parameters.";

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        setSettingsAgent(settings.agentCommand ?? "");
        setSettingsModel(settings.model ?? "");
      })
      .catch(() => {
        if (!alive) return;
        setSettingsAgent("");
        setSettingsModel("");
      });
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    if (settingsAgent === null) return;
    const available = agents.filter((item) => item.available);
    if (!available.length) return;
    const savedAgentAvailable = settingsAgent !== "" && available.some((item) => item.command === settingsAgent);
    setAgent((current) => (current && available.some((item) => item.command === current) ? current : savedAgentAvailable ? settingsAgent : available[0]!.command));
    if (savedAgentAvailable && settingsModel) setModel((current) => current || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setComposerH(element.offsetHeight));
    observer.observe(element);
    setComposerH(element.offsetHeight);
    return () => observer.disconnect();
  }, []);

  const scrollMessagesToBottom = (behavior: ScrollBehavior = "auto"): void => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (typeof el.scrollTo === "function") {
      try {
        el.scrollTo({ top: el.scrollHeight, behavior });
      } catch {
        el.scrollTop = el.scrollHeight;
      }
    }
    stickBottom.current = true;
    setShowScrollToBottom(false);
  };

  const scheduleScrollMessagesToBottom = (behavior: ScrollBehavior = "auto"): void => {
    scrollMessagesToBottom(behavior);
    requestAnimationFrame(() => scrollMessagesToBottom(behavior));
    window.setTimeout(() => scrollMessagesToBottom(behavior), 80);
  };

  const updateBottomState = (): void => {
    const el = messagesRef.current;
    if (!el || messages.length === 0) {
      stickBottom.current = true;
      setShowScrollToBottom(false);
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    stickBottom.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  };

  useEffect(() => {
    if (stickBottom.current) scheduleScrollMessagesToBottom("auto");
  }, [messages.length, composerH]);

  const handleAgentChange = (value: string): void => {
    setAgent(value);
    setModel("");
    persistAgentModelDefaults(api, { agentCommand: value, model: "" });
  };

  const handleModelChange = (value: string): void => {
    setModel(value);
    persistAgentModelDefaults(api, { agentCommand: agent, model: value });
  };

  const submit = (): void => {
    const prompt = text.trim();
    if (!prompt) return;
    const tuned = tuneValues(effect, values, prompt);
    onValuesChange(tuned.values);
    setMessages((current) => [
      ...current,
      { id: nextId, role: "user", content: prompt },
      {
        id: nextId + 1,
        role: "assistant",
        content:
          tuned.changed.length > 0
            ? `Adjusted ${tuned.changed.join(", ")}. The preview and parameter panel are now using the updated values.`
            : effect.origin === "custom"
              ? "I kept the current values. For custom effects, edit the code or parameter schema on the right and the preview will update immediately."
              : "I kept the current values. Try naming a parameter or asking for a stronger, softer, warmer, or cooler treatment.",
      },
    ]);
    setNextId((id) => id + 2);
    setText("");
  };

  return (
    <aside aria-label="Effect Agent" className="relative flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="app-drag flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <button
          type="button"
          aria-label="Back to effects"
          title="Back to effects"
          onClick={onBack}
          className="app-no-drag flex min-w-0 items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronLeft size={16} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{effect.name}</span>
        </button>
      </div>

      <div
        ref={messagesRef}
        data-testid="effect-agent-messages"
        onScroll={updateBottomState}
        className={cn("min-h-0 flex-1 px-4 pt-5", hasConversationContent ? "space-y-3 overflow-auto" : "overflow-hidden")}
        style={hasConversationContent ? { paddingBottom: messageBottomPadding } : undefined}
      >
        {!hasConversationContent ? (
          <div className="grid h-full place-items-center">
            <div className="flex max-w-[16rem] flex-col items-center gap-3 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-border bg-card text-foreground">
                <Sparkles size={20} strokeWidth={1.75} />
              </span>
              <p className="text-sm leading-relaxed text-muted-foreground">{emptyText}</p>
            </div>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((message) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
                className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                    message.role === "user" ? "rounded-br-md bg-surface-2 text-foreground" : "rounded-bl-md bg-card text-foreground",
                  )}
                >
                  {message.content}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      <AnimatePresence>
        {showScrollToBottom ? (
          <motion.button
            type="button"
            aria-label="Scroll to bottom"
            onClick={() => scrollMessagesToBottom("smooth")}
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.25, 1, 0.5, 1] }}
            className="app-no-drag absolute right-4 z-30 grid size-8 place-items-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ bottom: scrollToBottomBottom }}
          >
            <ArrowDown size={15} strokeWidth={1.8} aria-hidden />
          </motion.button>
        ) : null}
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        <div aria-hidden className="bg-gradient-to-t from-background via-background/90 to-transparent" style={{ height: FLOATING_COMPOSER_FADE_PX }} />
        <div ref={composerRef} className="bg-background px-3 pb-3">
          <div
            data-testid="effect-agent-composer"
            className="pointer-events-auto relative rounded-2xl border border-input bg-card px-2.5 pb-2 pt-2.5 transition-[color,border-color,box-shadow] duration-150 hover:border-border-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring"
          >
            <textarea
              aria-label="Message"
              rows={1}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={effect.origin === "custom" ? "Ask for shader code or parameter changes..." : "Ask for stronger grain, warmer light, softer motion..."}
              className="field-sizing-content max-h-40 min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="mt-1 flex items-center justify-end gap-2">
              <TooltipProvider delayDuration={120}>
                <div className="flex min-w-0 items-center gap-1">
                  <AgentModelSelect
                    agents={agents}
                    agent={agent}
                    model={model}
                    dropUp
                    onAgentChange={handleAgentChange}
                    onModelChange={handleModelChange}
                    onRescan={rescanAgents}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" size="icon-sm" aria-label="Send" onClick={submit} disabled={!text.trim()} className="ml-0.5 rounded-lg">
                        <ArrowUp size={15} strokeWidth={2} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={2}>Send</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
