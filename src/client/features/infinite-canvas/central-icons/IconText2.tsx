import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconText2 = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconText2(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M3.75 3.75H12H20.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 20.25V3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </CentralIcon>
  );
});
