import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../../lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  align = "center",
  side = "top",
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Omit<TooltipPrimitive.Positioner.Props, "children"> & {
    children: React.ReactNode;
  }): React.ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-[90]">
        <TooltipPrimitive.Popup
          className={cn(
            "z-[90] overflow-hidden rounded-[8px] border border-white/10 bg-[#121212] px-3 py-1.5 text-xs text-white shadow-[0_18px_40px_rgb(0_0_0/0.4)] backdrop-blur-xl",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
