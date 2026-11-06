import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconArrowCornerDownRight = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconArrowCornerDownRight(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M3.75 4.75V12.25C3.75 13.9069 5.09315 15.25 6.75 15.25H19.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.25 11.25L20.25 15.25L16.25 19.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </CentralIcon>
  );
});
