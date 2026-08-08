import {
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
  menuType,
}: {
  onChoose: (kind: DesignNodeKind) => void;
  menuType: "dropdown" | "context";
}) {
  return (["generate", "context"] as const).map((category) => {
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
  });
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
