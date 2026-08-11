import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { useInterruptiblePresenceMotion } from "./use-interruptible-presence-motion";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const motionRef = useInterruptiblePresenceMotion<HTMLDivElement>(ref, {
    openDurationMs: 220,
    closeDurationMs: 150,
  });
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={motionRef}
        data-slot="popover-content"
        data-dezin-menu-presence=""
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 max-h-(--radix-popover-content-available-height) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border-[0.5px] border-border/80 bg-popover/95 p-1.5 text-popover-foreground shadow-pop outline-none backdrop-blur-xl",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
