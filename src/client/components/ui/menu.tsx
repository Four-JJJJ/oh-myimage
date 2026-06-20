import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type React from "react";
import { cn } from "../../lib/utils";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;

function MenuPopup({
  className,
  sideOffset = 8,
  align = "end",
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Omit<MenuPrimitive.Positioner.Props, "children"> & {
    children: React.ReactNode;
  }): React.ReactElement {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          data-slot="menu-popup"
          className={cn(
            "z-40 min-w-[180px] overflow-hidden rounded-[16px] border border-white/12 bg-[#202020]/96 p-1 text-white shadow-[0_18px_44px_rgb(0_0_0/0.42)] outline-none backdrop-blur-xl",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup({ className, ...props }: MenuPrimitive.Group.Props): React.ReactElement {
  return <MenuPrimitive.Group data-slot="menu-group" className={cn("flex flex-col gap-1", className)} {...props} />;
}

function MenuItem({
  className,
  inset = false,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}): React.ReactElement {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        "flex cursor-default items-center gap-3 rounded-[12px] px-3 py-2.5 text-sm leading-5 text-white/88 outline-none transition data-[highlighted]:bg-white/10 data-[highlighted]:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        inset && "pl-9",
        variant === "destructive" && "text-[#ff4050] data-[highlighted]:bg-[#ff4f4f]/14 data-[highlighted]:text-[#ff4050]",
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div data-slot="menu-separator" className={cn("my-1 h-px bg-white/10", className)} {...props} />;
}

export { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger };
