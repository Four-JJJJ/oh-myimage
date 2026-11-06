import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconPlusSmall = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconPlusSmall(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M12 6.75V12M12 12V17.25M12 12H6.75M12 12H17.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </CentralIcon>
  );
});
