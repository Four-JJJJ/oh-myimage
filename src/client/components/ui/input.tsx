import * as React from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, type, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        "ohm-smooth-control h-10 w-full border border-white/15 bg-transparent px-4 text-sm font-medium text-white/90 outline-none transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-white/35 focus-visible:ring-2 focus-visible:ring-white/15 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export { Input };
