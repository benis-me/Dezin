import { FileUp, LayoutTemplate, MessageSquareText, Search, Sparkles } from "lucide-react";

export function QuickStart({
  onAddPage,
  onAddResearch,
  onImport,
  onOpenMainAgent,
}: {
  onAddPage: () => void;
  onAddResearch: () => void;
  onImport: () => void;
  onOpenMainAgent: () => void;
}) {
  return (
    <section className="design-canvas-quick-start" aria-labelledby="design-canvas-quick-start-title">
      <span className="design-canvas-quick-start__mark"><Sparkles aria-hidden /></span>
      <div className="design-canvas-quick-start__intro">
        <span className="design-canvas-quick-start__eyebrow">A blank canvas</span>
        <h2 id="design-canvas-quick-start-title">Quick Start</h2>
        <p>Begin with one useful artifact. Everything you add becomes shared context for the Agents that follow.</p>
      </div>
      <div className="design-canvas-quick-start__actions">
        <button type="button" onClick={onAddPage}><span><LayoutTemplate aria-hidden /></span><div><strong>Create a page</strong><small>Start with a complete screen</small></div></button>
        <button type="button" onClick={onAddResearch}><span><Search aria-hidden /></span><div><strong>Research a direction</strong><small>Collect evidence before designing</small></div></button>
        <button type="button" onClick={onImport}><span><FileUp aria-hidden /></span><div><strong>Bring in context</strong><small>Images, video, documents, or files</small></div></button>
        <button type="button" onClick={onOpenMainAgent}><span><MessageSquareText aria-hidden /></span><div><strong>Plan with the Main Agent</strong><small>Compose and dispatch several Nodes</small></div></button>
      </div>
      <p className="design-canvas-quick-start__hint">Right-click anywhere to add any Node</p>
    </section>
  );
}
