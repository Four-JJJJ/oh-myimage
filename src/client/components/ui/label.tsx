import * as React from "react";
import { cn } from "../../lib/utils";

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(function Label({ className, ...props }, ref) {
  return <label ref={ref} className={cn("text-sm font-medium leading-none text-white/88", className)} {...props} />;
});

export { Label };
