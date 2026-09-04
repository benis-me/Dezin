import { ArrowRight, FileUp, LayoutTemplate, Library, MessageSquareText, Search } from "lucide-react";

export function QuickStart({
  onAddPage,
  onAddResearch,
  onCreateComponentSystem,
  onImport,
  onOpenMainAgent,
  onAddGroupChat,
}: {
  onAddPage: () => void;
  onAddResearch: () => void;
  onCreateComponentSystem: () => void;
  onImport: () => void;
  onOpenMainAgent: () => void;
  onAddGroupChat: () => void;
}) {
  return (
    <section className="design-canvas-quick-start" aria-labelledby="design-canvas-quick-start-title">
      <div className="design-canvas-quick-start__intro">
        <h2 id="design-canvas-quick-start-title">Quick Start</h2>
        <p>Make a design, explore a direction, or bring your references.</p>
      </div>
      <div className="design-canvas-quick-start__actions">
        <button className="design-canvas-quick-start__featured" type="button" onClick={onAddPage}>
          <LayoutTemplate aria-hidden />
          <span className="design-canvas-quick-start__copy">
            <strong>Create a page</strong>
            <small>A website, mobile screen, or visual concept</small>
          </span>
          <ArrowRight aria-hidden />
        </button>
        <div className="design-canvas-quick-start__secondary" role="group" aria-label="More ways to start">
          <button type="button" onClick={onAddGroupChat}><MessageSquareText aria-hidden /><span>Start a group chat</span></button>
          <button type="button" onClick={onCreateComponentSystem}><Library aria-hidden /><span>Build a component system</span></button>
          <button type="button" onClick={onAddResearch}><Search aria-hidden /><span>Research</span></button>
          <button type="button" onClick={onImport}><FileUp aria-hidden /><span>Import</span></button>
          <button type="button" onClick={onOpenMainAgent}><MessageSquareText aria-hidden /><span>Ask Main Agent</span></button>
        </div>
      </div>
      <p className="design-canvas-quick-start__hint">Designs and conversations are saved here. Use + for every Node type.</p>
    </section>
  );
}
