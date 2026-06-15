import { IconChevronDownSmall } from "@central-icons-react/round-filled-radius-2-stroke-1.5";
import { Loader2 } from "lucide-react";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function CossButton({
  className,
  variant = "default",
  size = "default",
  loading = false,
  children,
  type = "button",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "icon";
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      data-slot="button"
      data-loading={loading ? "" : undefined}
      className={cn(
        "ohm-smooth-control inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/20 disabled:pointer-events-none disabled:opacity-50",
        size === "default" && "h-8 px-3",
        size === "sm" && "h-7 px-2 text-xs",
        size === "icon" && "size-8 px-0",
        variant === "default" && "border-white/20 bg-white/85 text-black hover:bg-white",
        variant === "outline" && "border-white/15 bg-[#2a2a2a] text-white/88 hover:bg-white/12",
        variant === "ghost" && "border-transparent bg-transparent text-white/72 hover:bg-white/10 hover:text-white",
        variant === "secondary" && "border-transparent bg-white/10 text-white/78 hover:bg-white/15",
        className,
      )}
      {...props}
    >
      {loading && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export const CossTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function CossTextarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "min-h-[42px] w-full resize-none overflow-hidden bg-transparent text-sm leading-6 text-white/78 outline-none placeholder:text-white/30",
        className,
      )}
      {...props}
    />
  );
});
CossTextarea.displayName = "CossTextarea";

export function CossSelect({
  className,
  icon,
  showChevron = true,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  children: ReactNode;
  icon?: ReactNode;
  showChevron?: boolean;
}) {
  return (
    <label
      className={cn(
        "ohm-smooth-control relative inline-flex h-8 min-w-0 shrink-0 items-center justify-center gap-1 border border-white/20 bg-white/10 px-3 py-1 text-sm leading-[22px] text-white",
        className,
      )}
    >
      {icon && <span className="pointer-events-none grid size-4 shrink-0 place-items-center text-white/90">{icon}</span>}
      <select
        data-slot="select"
        className={cn(
          "h-full min-w-0 appearance-none rounded-[inherit] bg-transparent p-0 text-sm leading-[22px] text-white outline-none disabled:opacity-100",
          showChevron ? "pr-5" : "pr-0",
        )}
        {...props}
      >
        {children}
      </select>
      {showChevron && <IconChevronDownSmall ariaHidden size={20} className="pointer-events-none absolute right-1.5 text-white/60" />}
    </label>
  );
}

export function CossBadge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      data-slot="badge"
      className={cn("ohm-smooth-chip inline-flex h-5 shrink-0 items-center bg-white/8 px-2 text-[11px] leading-none text-white/52", className)}
    >
      {children}
    </span>
  );
}

export function CossSeparator({ className }: { className?: string }) {
  return <div data-slot="separator" className={cn("h-px w-full bg-white/8", className)} />;
}

export function CossSpinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} />;
}
