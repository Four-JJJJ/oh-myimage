import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import * as React from "react";
import { cn } from "../../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;
const PopoverDescription = PopoverPrimitive.Description;

function PopoverPopup({
  className,
  sideOffset = 8,
  align = "start",
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup> &
  Pick<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Positioner>, "align" | "side" | "sideOffset" | "alignOffset">): React.ReactElement {
  const { side, alignOffset, ...popupProps } = props;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} alignOffset={alignOffset} className="z-50 outline-none">
        <PopoverPrimitive.Popup
          className={cn(
            "rounded-[16px] border border-white/[0.1] bg-[#191919] p-3 text-white shadow-[0_22px_70px_rgb(0_0_0/0.55)] outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            className,
          )}
          {...popupProps}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger };
