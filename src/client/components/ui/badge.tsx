import * as React from "react";
import { cn } from "../../lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "destructive" | "outline";
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "ohm-smooth-chip inline-flex items-center border px-2 py-0.5 text-xs font-medium transition-colors",
        variant === "default" && "border-white/15 bg-white/10 text-white/88",
        variant === "secondary" && "border-transparent bg-white/10 text-white/72",
        variant === "destructive" && "border-[#ff6b6b]/25 bg-[#ff4f4f]/12 text-[#ffb3b3]",
        variant === "outline" && "border-white/15 bg-transparent text-white/72",
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
