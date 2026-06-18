import * as React from "react";
import { cn } from "../../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "ohm-smooth-control min-h-24 w-full border border-white/15 bg-transparent px-4 py-3 text-sm leading-6 text-white/90 outline-none transition-colors placeholder:text-white/35 focus-visible:ring-2 focus-visible:ring-white/15 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export { Textarea };
