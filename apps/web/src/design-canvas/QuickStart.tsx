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
      <div>
        <h2 id="design-canvas-quick-start-title">Quick Start</h2>
        <p>Start from a node, bring in context, or let the Main Agent compose the canvas.</p>
      </div>
      <div className="design-canvas-quick-start__actions">
        <button type="button" onClick={onAddPage}><LayoutTemplate aria-hidden /><span><strong>Page</strong><small>Design a complete screen</small></span></button>
        <button type="button" onClick={onAddResearch}><Search aria-hidden /><span><strong>Research</strong><small>Ground the design direction</small></span></button>
        <button type="button" onClick={onImport}><FileUp aria-hidden /><span><strong>Import context</strong><small>Images, video, docs, files</small></span></button>
        <button type="button" onClick={onOpenMainAgent}><MessageSquareText aria-hidden /><span><strong>Main Agent</strong><small>Coordinate nodes and Agents</small></span></button>
      </div>
      <p className="design-canvas-quick-start__hint">You can also right-click anywhere on the canvas.</p>
    </section>
  );
}
