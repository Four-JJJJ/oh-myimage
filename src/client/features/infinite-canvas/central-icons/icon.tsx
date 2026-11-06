import { forwardRef, type ReactNode, type SVGProps } from "react";

export const CentralIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement> & { children: ReactNode }>(function CentralIcon({ children, ...props }, ref) {
  return (
    <svg ref={ref} width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
});
