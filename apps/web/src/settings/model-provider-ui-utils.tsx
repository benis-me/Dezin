import { Aperture, CheckCircle2, Cloud, Cpu, Flame, Router, Triangle, Waves } from "lucide-react";
import { AgentLogo } from "../components/agent-logos.tsx";
import type { ModelCapability } from "./model-provider-registry.ts";

export interface ModelProviderEntry {
  id: string;
  name?: string;
  capabilities?: ModelCapability[];
}

export function inferCapabilities(id: string): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  if (/image|flux|imagen|seedream|midjourney/i.test(id)) capabilities.push("Image");
  if (/video|veo|wan|sora/i.test(id)) capabilities.push("Video");
  if (/vision|gpt|claude|gemini/i.test(id)) capabilities.push("Vision");
  if (/gpt|claude|gemini|llama/i.test(id)) capabilities.push("Stream");
  return capabilities.length ? capabilities : ["Stream"];
}

export function modelTextToIds(text: string): string[] {
  return parseModelEntries(text).map((entry) => entry.id);
}

export function parseModelEntries(text: string): ModelProviderEntry[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseModelEntry)
    .filter((entry): entry is ModelProviderEntry => Boolean(entry?.id));
}

export function serializeModelEntries(entries: ModelProviderEntry[]): string {
  return entries
    .filter((entry) => entry.id.trim())
    .map((entry) => {
      const next = {
        id: entry.id.trim(),
        name: entry.name?.trim() || undefined,
        capabilities: entry.capabilities?.length ? entry.capabilities : undefined,
      };
      if (!next.name && !next.capabilities) return next.id;
      return JSON.stringify(next);
    })
    .join("\n");
}

function parseModelEntry(line: string): ModelProviderEntry | null {
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as Partial<ModelProviderEntry>;
      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      if (!id) return null;
      return {
        id,
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.filter(isModelCapability) : undefined,
      };
    } catch {
      return { id: line };
    }
  }
  return { id: line };
}

function isModelCapability(value: unknown): value is ModelCapability {
  return ["Stream", "Tools", "Vision", "JSON", "Reasoning", "Image", "Video", "Local"].includes(String(value));
}

export function ProviderIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  if (id === "openai" || id === "openai-compatible") return <AgentLogo id="codex" className={className} />;
  if (id === "anthropic") return <AgentLogo id="claude" className={className} />;
  if (id === "gemini" || id === "vertex-ai") return <AgentLogo id="gemini" className={className} />;
  if (id === "azure-openai") return <Cloud className={className} strokeWidth={1.75} />;
  if (id === "openrouter") return <Router className={className} strokeWidth={1.75} />;
  if (id === "ollama") return <Cpu className={className} strokeWidth={1.75} />;
  if (id === "fal") return <Triangle className={className} strokeWidth={1.75} />;
  if (id === "wavespeed") return <Waves className={className} strokeWidth={1.75} />;
  if (id === "volcengine") return <Flame className={className} strokeWidth={1.75} />;
  if (id === "midjourney-gateway") return <Aperture className={className} strokeWidth={1.75} />;
  if (id === "mock") return <CheckCircle2 className={className} strokeWidth={1.75} />;
  return <Cloud className={className} strokeWidth={1.75} />;
}
