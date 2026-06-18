import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive" | "link";
  size?: "xs" | "sm" | "default" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", loading = false, type = "button", disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      className={cn(
        "ohm-smooth-control inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/20 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
        size === "xs" && "h-7 rounded-[10px] px-2 text-xs",
        size === "sm" && "h-8 rounded-[12px] px-3 text-sm",
        size === "default" && "h-10 rounded-[14px] px-4",
        size === "lg" && "h-11 rounded-[16px] px-5 text-[15px]",
        size === "icon-xs" && "size-7 rounded-[10px] px-0",
        size === "icon-sm" && "size-8 rounded-[12px] px-0",
        size === "icon" && "size-10 rounded-[14px] px-0",
        size === "icon-lg" && "size-11 rounded-[16px] px-0",
        variant === "default" && "border-white/25 bg-white/90 text-black shadow-[0_8px_30px_rgba(255,255,255,0.12)] hover:bg-white/95",
        variant === "outline" && "border-white/14 bg-white/[0.04] text-white/88 hover:bg-white/[0.08]",
        variant === "ghost" && "border-transparent bg-transparent text-white/72 hover:bg-white/[0.08] hover:text-white",
        variant === "secondary" && "border-transparent bg-white/[0.08] text-white/78 hover:bg-white/[0.12]",
        variant === "destructive" && "border-[#ff6b6b]/24 bg-[#ff4f4f]/12 text-[#ffd2d2] hover:bg-[#ff4f4f]/18",
        variant === "link" && "border-transparent bg-transparent px-0 text-white/88 hover:text-white hover:underline",
        className,
      )}
      {...props}
    >
      {loading && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
});

export { Button };
