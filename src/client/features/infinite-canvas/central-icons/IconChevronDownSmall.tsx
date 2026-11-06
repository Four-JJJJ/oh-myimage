import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconChevronDownSmall = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconChevronDownSmall(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M8 10L10.9393 12.9393C11.5251 13.5251 12.4749 13.5251 13.0607 12.9393L16 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </CentralIcon>
  );
});
