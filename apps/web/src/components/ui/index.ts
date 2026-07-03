// shadcn/ui primitives
export { Button, buttonVariants } from "./Button.tsx";
export { Badge, badgeVariants } from "./Badge.tsx";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./Card.tsx";
export { Input, SearchInput } from "./input.tsx";
export { Textarea } from "./textarea.tsx";
export { Label } from "./label.tsx";
export { Switch } from "./switch.tsx";
export { Separator } from "./separator.tsx";
export { ScrollArea, ScrollBar } from "./scroll-area.tsx";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu.tsx";
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip.tsx";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";

// Dezin adapters (Dezin's simple APIs over shadcn primitives)
export { Dialog } from "./overlay.tsx";
export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from "./popover.tsx";
export { Tabs, type TabItem } from "./segmented.tsx";
export { Field } from "./Field.tsx";

// Dezin-only helpers built on shadcn primitives
export { IconButton, Kbd } from "./IconButton.tsx";
export { Spinner, Skeleton, Loading } from "./feedback.tsx";
export { Picker, type PickerOption } from "./Picker.tsx";
export { Segmented, type SegmentedOption } from "./SegmentedControl.tsx";
export { PanelBar } from "./PanelBar.tsx";
export { FadeIn, Stagger, StaggerItem } from "./motion-primitives.tsx";
