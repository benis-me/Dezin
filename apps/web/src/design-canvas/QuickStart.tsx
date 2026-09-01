import { ArrowRight, FileUp, LayoutTemplate, Library, MessageSquareText, Search } from "lucide-react";

export function QuickStart({
  onAddPage,
  onAddResearch,
  onCreateComponentSystem,
  onImport,
  onOpenMainAgent,
}: {
  onAddPage: () => void;
  onAddResearch: () => void;
  onCreateComponentSystem: () => void;
  onImport: () => void;
  onOpenMainAgent: () => void;
}) {
  return (
    <section className="design-canvas-quick-start" aria-labelledby="design-canvas-quick-start-title">
      <div className="design-canvas-quick-start__intro">
        <h2 id="design-canvas-quick-start-title">Quick Start</h2>
        <p>Choose a starting point. You can connect and refine every Node later.</p>
      </div>
      <div className="design-canvas-quick-start__actions">
        <button className="design-canvas-quick-start__featured" type="button" onClick={onCreateComponentSystem}>
          <Library aria-hidden />
          <span className="design-canvas-quick-start__copy">
            <strong>Build a component system</strong>
            <small>Foundations, components, and documentation</small>
          </span>
          <ArrowRight aria-hidden />
        </button>
        <div className="design-canvas-quick-start__secondary" role="group" aria-label="More ways to start">
          <button type="button" onClick={onAddPage}><LayoutTemplate aria-hidden /><span>Create a page</span></button>
          <button type="button" onClick={onAddResearch}><Search aria-hidden /><span>Research</span></button>
          <button type="button" onClick={onImport}><FileUp aria-hidden /><span>Import</span></button>
          <button type="button" onClick={onOpenMainAgent}><MessageSquareText aria-hidden /><span>Ask Main Agent</span></button>
        </div>
      </div>
      <p className="design-canvas-quick-start__hint">Use + or right-click for every Node type</p>
    </section>
  );
}
