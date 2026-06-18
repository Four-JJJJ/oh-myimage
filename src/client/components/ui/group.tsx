import * as React from "react";
import { cn } from "../../lib/utils";

function Group({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
}): React.ReactElement {
  return (
    <div
      data-orientation={orientation}
      data-slot="group"
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-[18px]",
        orientation === "horizontal" ? "flex-row" : "flex-col",
        className,
      )}
      {...props}
    />
  );
}

function GroupSeparator({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
}): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-orientation={orientation}
      data-slot="group-separator"
      className={cn(
        "shrink-0 bg-white/10",
        orientation === "horizontal" ? "my-1 w-px self-stretch" : "mx-1 h-px",
        className,
      )}
      {...props}
    />
  );
}

export { Group, GroupSeparator };
