import { CheckCircle2, Sparkles } from "lucide-react";
import { AgentLogo } from "../components/agent-logos.tsx";
import type { ModelCapability } from "./model-provider-registry.ts";

export function inferCapabilities(id: string): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  if (/image|flux|imagen|seedream|midjourney/i.test(id)) capabilities.push("Image");
  if (/video|veo|wan|sora/i.test(id)) capabilities.push("Video");
  if (/vision|gpt|claude|gemini/i.test(id)) capabilities.push("Vision");
  if (/gpt|claude|gemini|llama/i.test(id)) capabilities.push("Stream");
  return capabilities.length ? capabilities : ["Stream"];
}

export function modelTextToIds(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ProviderIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  if (id === "openai" || id === "openai-compatible" || id === "openrouter") return <AgentLogo id="codex" className={className} />;
  if (id === "anthropic") return <AgentLogo id="claude" className={className} />;
  if (id === "gemini" || id === "vertex-ai") return <AgentLogo id="gemini" className={className} />;
  if (id === "mock") return <CheckCircle2 className={className} strokeWidth={1.75} />;
  return <Sparkles className={className} strokeWidth={1.75} />;
}
