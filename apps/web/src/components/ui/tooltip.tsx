import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useInterruptiblePresenceMotion } from "./use-interruptible-presence-motion"

function TooltipProvider({
  delayDuration = 0,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const motionRef = useInterruptiblePresenceMotion<HTMLDivElement>(ref, {
    openDurationMs: 160,
    closeDurationMs: 110,
    distancePx: 5,
    openScale: 0.98,
    skipAnimationOnInstantOpen: true,
  })
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={motionRef}
        data-slot="tooltip-content"
        data-dezin-menu-presence=""
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-lg border border-white/8 bg-neutral-900/95 px-2.5 py-1.5 text-[10px] font-medium text-balance text-neutral-100 shadow-pop backdrop-blur-xl",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
