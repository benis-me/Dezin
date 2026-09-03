import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Bot,
  Download,
  LoaderCircle,
  MessageSquarePlus,
  Monitor,
  Smartphone,
  Tablet,
} from "lucide-react";

import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { CanvasToolButton } from "./CanvasToolDocks.tsx";
import type { NodeFocusPhase } from "./node-focus-motion.ts";

const FOCUS_CHROME_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

export type FocusedPreviewDevice = "desktop" | "tablet" | "mobile";

export function FocusedNodeChrome({
  transition,
  motionAllowed,
  durationMs,
  previewToolsVisible,
  previewDevice,
  previewExporting,
  agentVisible,
  annotateAvailable = false,
  annotateMode = false,
  onClose,
  onChooseDevice,
  onExport,
  onSetAgentVisible,
  onToggleAnnotate,
}: {
  transition: { nodeId: string; phase: NodeFocusPhase } | null;
  motionAllowed: boolean;
  durationMs: number;
  previewToolsVisible: boolean;
  previewDevice: FocusedPreviewDevice;
  previewExporting: boolean;
  agentVisible: boolean;
  annotateAvailable?: boolean;
  annotateMode?: boolean;
  onClose: () => void;
  onChooseDevice: (device: FocusedPreviewDevice) => void;
  onExport: () => void;
  onSetAgentVisible: (visible: boolean) => void;
  onToggleAnnotate?: () => void;
}) {
  return (
    <>
      <AnimatePresence initial={false}>
        {transition ? (
          <motion.div
            key={`focus-dismiss-${transition.nodeId}`}
            className="design-canvas-focus-dismiss"
            aria-hidden
            initial={motionAllowed ? { opacity: 0 } : false}
            animate={{ opacity: transition.phase === "closing" ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: motionAllowed ? durationMs / 1_000 : 0,
              ease: FOCUS_CHROME_EASE,
            }}
            onClick={onClose}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {transition ? (
          <motion.div
            key={`focus-back-${transition.nodeId}`}
            className="design-canvas-focus-back"
            initial={motionAllowed ? { opacity: 0, transform: "translate3d(-6px, 0px, 0px) scale(0.96)" } : false}
            animate={transition.phase === "closing"
              ? {
                  opacity: 0,
                  transform: "translate3d(-5px, 0px, 0px) scale(0.97)",
                  transition: { duration: motionAllowed ? 0.13 : 0, ease: FOCUS_CHROME_EASE },
                }
              : {
                  opacity: 1,
                  transform: "translate3d(0px, 0px, 0px) scale(1)",
                  transition: {
                    duration: motionAllowed ? 0.18 : 0,
                    delay: motionAllowed ? 0.08 : 0,
                    ease: FOCUS_CHROME_EASE,
                  },
                }}
            exit={{
              opacity: 0,
              transform: "translate3d(-5px, 0px, 0px) scale(0.97)",
              transition: { duration: motionAllowed ? 0.13 : 0, ease: FOCUS_CHROME_EASE },
            }}
          >
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Close Node focus" onClick={onClose}>
                    <ArrowLeft aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6}>Back to canvas</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {transition ? (
          <motion.div
            key={`focus-actions-${transition.nodeId}`}
            className="design-canvas-focus-actions"
            role="toolbar"
            aria-label="Focused preview tools"
            initial={motionAllowed ? { opacity: 0, transform: "translate3d(0px, 7px, 0px) scale(0.98)" } : false}
            animate={transition.phase === "closing"
              ? {
                  opacity: 0,
                  transform: "translate3d(0px, 6px, 0px) scale(0.98)",
                  transition: { duration: motionAllowed ? 0.2 : 0, ease: FOCUS_CHROME_EASE },
                }
              : {
                  opacity: 1,
                  transform: "translate3d(0px, 0px, 0px) scale(1)",
                  transition: {
                    duration: motionAllowed ? 0.26 : 0,
                    delay: motionAllowed ? 0.1 : 0,
                    ease: FOCUS_CHROME_EASE,
                  },
                }}
            exit={{
              opacity: 0,
              transform: "translate3d(0px, 6px, 0px) scale(0.98)",
              transition: { duration: motionAllowed ? 0.2 : 0, ease: FOCUS_CHROME_EASE },
            }}
          >
            <TooltipProvider delayDuration={120}>
              {previewToolsVisible ? (
                <span className="design-canvas-focus-actions__devices" role="group" aria-label="Preview device">
                  <CanvasToolButton
                    label="Desktop preview"
                    active={previewDevice === "desktop"}
                    onClick={() => onChooseDevice("desktop")}
                  >
                    <Monitor aria-hidden />
                  </CanvasToolButton>
                  <CanvasToolButton
                    label="Tablet preview"
                    active={previewDevice === "tablet"}
                    onClick={() => onChooseDevice("tablet")}
                  >
                    <Tablet aria-hidden />
                  </CanvasToolButton>
                  <CanvasToolButton
                    label="Mobile preview"
                    active={previewDevice === "mobile"}
                    onClick={() => onChooseDevice("mobile")}
                  >
                    <Smartphone aria-hidden />
                  </CanvasToolButton>
                </span>
              ) : null}
              {previewToolsVisible || (annotateAvailable && onToggleAnnotate) ? <span className="design-canvas-tools__divider" aria-hidden /> : null}
              {annotateAvailable && onToggleAnnotate ? (
                <CanvasToolButton
                  label={annotateMode ? "Stop commenting (C)" : "Comment on an element (C)"}
                  active={annotateMode}
                  onClick={onToggleAnnotate}
                >
                  <MessageSquarePlus aria-hidden />
                </CanvasToolButton>
              ) : null}
              {previewToolsVisible ? (
                <CanvasToolButton
                  label={previewExporting ? "Exporting" : "Export"}
                  disabled={previewExporting}
                  onClick={onExport}
                >
                  {previewExporting ? <LoaderCircle aria-hidden className="animate-spin" /> : <Download aria-hidden />}
                </CanvasToolButton>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={agentVisible ? "Hide Node Agent" : "Show Node Agent"}
                    aria-pressed={agentVisible}
                    onClick={() => onSetAgentVisible(!agentVisible)}
                  >
                    <Bot aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={7}>
                  {agentVisible ? "Hide Agent" : "Show Agent"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
