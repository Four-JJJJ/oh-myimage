import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type React from "react";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "ohm-smooth-control inline-flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-[12px] border border-white/15 bg-transparent px-4 text-left text-sm font-semibold text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-white/15 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon" className="pointer-events-none shrink-0 text-white/60">
        <ChevronDown size={20} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props): React.ReactElement {
  return <SelectPrimitive.Value data-slot="select-value" className={cn("min-w-0 flex-1 truncate", className)} {...props} />;
}

function SelectPopup({ className, children, ...props }: SelectPrimitive.Popup.Props): React.ReactElement {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner align="start" sideOffset={8} alignItemWithTrigger={false} className="z-50 outline-none">
        <SelectPrimitive.Popup
          data-slot="select-popup"
          className={cn(
            "w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-hidden rounded-[16px] border border-white/12 bg-[#202020] text-white shadow-[0_18px_44px_rgb(0_0_0/0.42)] outline-none",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List data-slot="select-list" className="max-h-[min(320px,var(--available-height))] overflow-y-auto overscroll-contain p-1">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props): React.ReactElement {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "grid min-h-10 cursor-default grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 rounded-[12px] px-3 py-2.5 text-sm leading-5 text-white/90 outline-none transition-colors data-[highlighted]:bg-white/10 data-[highlighted]:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 break-words">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="col-start-2"><Check aria-hidden className="size-4" /></SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem };
