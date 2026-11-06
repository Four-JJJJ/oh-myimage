import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconArrowCornerUpLeft = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconArrowCornerUpLeft(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M20.25 19.25V11.75C20.25 10.0931 18.9069 8.75 17.25 8.75H4.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.75 12.75L3.75 8.75L7.75 4.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </CentralIcon>
  );
});
