import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type React from "react";
import { cn } from "../../lib/utils";

export type TabsVariant = "default" | "underline";

function Tabs({ className, ...props }: TabsPrimitive.Root.Props): React.ReactElement {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-2 data-[orientation=vertical]:flex-row", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

function TabsList({
  variant = "default",
  className,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}): React.ReactElement {
  return (
    <TabsPrimitive.List
      className={cn(
        "relative z-0 flex w-fit items-center justify-center gap-x-0.5 text-muted-foreground data-[orientation=vertical]:flex-col",
        variant === "default" && "rounded-[8px] bg-muted p-0.5 text-muted-foreground/72",
        variant === "underline" && "data-[orientation=vertical]:px-1 data-[orientation=horizontal]:py-1 *:data-[slot=tabs-tab]:hover:bg-accent",
        className,
      )}
      data-slot="tabs-list"
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className={cn(
          "absolute bottom-0 left-0 h-[var(--active-tab-height)] w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] translate-y-[calc(var(--active-tab-bottom)*-1)] transition-[width,translate] duration-200 ease-in-out",
          variant === "underline" &&
            "z-10 bg-primary data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px data-[orientation=horizontal]:translate-y-px",
          variant === "default" &&
            "-z-10 [background:var(--tabs-indicator-bg,hsl(var(--background)))] [border:var(--tabs-indicator-border,0)] [border-radius:var(--tabs-indicator-radius,var(--radius))] [box-shadow:var(--tabs-indicator-shadow,0_1px_2px_rgb(0_0_0/0.05))]",
        )}
        data-slot="tab-indicator"
      />
    </TabsPrimitive.List>
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props): React.ReactElement {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-transparent px-2.5 text-base font-medium outline-none transition-[color,background-color,box-shadow] hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:text-foreground data-disabled:opacity-64 sm:h-8 sm:text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props): React.ReactElement {
  return <TabsPrimitive.Panel className={cn("flex-1 outline-none", className)} data-slot="tabs-content" {...props} />;
}

export { Tabs, TabsList, TabsPanel, TabsPanel as TabsContent, TabsPrimitive, TabsTab, TabsTab as TabsTrigger };
