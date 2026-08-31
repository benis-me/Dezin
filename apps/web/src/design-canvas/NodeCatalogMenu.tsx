import {
  ArrowRight,
  Box,
  Braces,
  Component,
  File,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  Library,
  Palette,
  Search,
  Video,
  type LucideIcon,
} from "lucide-react";

import {
  ContextMenuItem,
  DropdownMenuItem,
} from "../components/ui/index.ts";
import { DESIGN_NODE_CATALOG, type DesignNodeCatalogItem } from "./catalog.ts";
import type { DesignNodeKind } from "./types.ts";

const ICONS: Record<DesignNodeKind, LucideIcon> = {
  component: Component,
  page: LayoutTemplate,
  "design-system": Palette,
  research: Search,
  "design-tokens": Braces,
  "design-document": FileText,
  layout: Box,
  knowledge: Library,
  image: ImageIcon,
  video: Video,
  document: FileText,
  file: File,
};

export function NodeCatalogMenu({
  onChoose,
  onCreateComponentSystem,
  menuType,
}: {
  onChoose: (kind: DesignNodeKind) => void;
  onCreateComponentSystem: () => void;
  menuType: "dropdown" | "context";
}) {
  const starterLabelId = `design-node-catalog-${menuType}-starter`;
  const starterContent = (
    <>
      <span className="design-node-catalog__icon"><Library aria-hidden /></span>
      <span className="min-w-0">
        <strong>Build a component system</strong>
        {menuType === "dropdown" ? <small>System, library, tokens, and Design.md</small> : null}
      </span>
      <ArrowRight className="design-node-catalog__starter-arrow" aria-hidden />
    </>
  );
  return (
    <>
      <section className="design-node-catalog__starter" role="group" aria-labelledby={starterLabelId}>
        <p id={starterLabelId} className="design-node-catalog__label">Start a system</p>
        {menuType === "context" ? (
          <ContextMenuItem className="design-node-catalog__item" onSelect={onCreateComponentSystem}>
            {starterContent}
          </ContextMenuItem>
        ) : (
          <DropdownMenuItem className="design-node-catalog__item" onSelect={onCreateComponentSystem}>
            {starterContent}
          </DropdownMenuItem>
        )}
      </section>
      {(["generate", "context"] as const).map((category) => {
        const labelId = `design-node-catalog-${menuType}-${category}`;
        return (
          <section key={category} role="group" aria-labelledby={labelId}>
            <p id={labelId} className="design-node-catalog__label">
              {category === "generate" ? "Generate" : "Add context"}
            </p>
            <div className="design-node-catalog__grid">
              {DESIGN_NODE_CATALOG.filter((item) => item.category === category).map((item) => (
                <CatalogMenuItem
                  key={item.kind}
                  item={item}
                  menuType={menuType}
                  onChoose={onChoose}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function CatalogMenuItem({
  item,
  menuType,
  onChoose,
}: {
  item: DesignNodeCatalogItem;
  menuType: "dropdown" | "context";
  onChoose: (kind: DesignNodeKind) => void;
}) {
  const Icon = ICONS[item.kind];
  const content = (
    <>
      <span className="design-node-catalog__icon"><Icon aria-hidden /></span>
      <span className="min-w-0">
        <strong>{item.label}</strong>
        {menuType === "dropdown" ? <small>{item.description}</small> : null}
      </span>
    </>
  );
  return menuType === "context" ? (
    <ContextMenuItem className="design-node-catalog__item" onSelect={() => onChoose(item.kind)}>
      {content}
    </ContextMenuItem>
  ) : (
    <DropdownMenuItem className="design-node-catalog__item" onSelect={() => onChoose(item.kind)}>
      {content}
    </DropdownMenuItem>
  );
}
