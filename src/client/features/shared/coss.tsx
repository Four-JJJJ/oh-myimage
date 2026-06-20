import { ChevronDown, Loader2 } from "lucide-react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Separator } from "../../components/ui/separator";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

export { Button as CossButton, Input as CossInput, Textarea as CossTextarea, Badge as CossBadge, Separator as CossSeparator };

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
      {showChevron && <ChevronDown aria-hidden size={20} className="pointer-events-none absolute right-1.5 text-white/60" />}
    </label>
  );
}

export function CossSpinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} />;
}
