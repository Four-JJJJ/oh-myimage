import * as React from "react";
import { cn } from "../../lib/utils";

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "destructive" | "success" | "warning";
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert({ className, variant = "default", ...props }, ref) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        "ohm-smooth-card relative w-full border p-4 text-sm",
        variant === "default" && "border-white/12 bg-white/[0.04] text-white/88",
        variant === "destructive" && "border-[#ff6b6b]/25 bg-[#ff4f4f]/10 text-[#ffd6d6]",
        variant === "success" && "border-white/18 bg-white/[0.08] text-white/92",
        variant === "warning" && "border-[#ffd464]/25 bg-[#ffd464]/12 text-[#fff0bd]",
        className,
      )}
      {...props}
    />
  );
});

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(function AlertTitle(
  { className, ...props },
  ref,
) {
  return <h5 ref={ref} className={cn("mb-1 font-medium leading-none tracking-normal", className)} {...props} />;
});

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(function AlertDescription(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />;
});

export { Alert, AlertDescription, AlertTitle };
