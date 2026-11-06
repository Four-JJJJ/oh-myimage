import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconPan = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconPan(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M15.8703 12.9552L23.1963 11.1494M2.80078 16.1767L15.8869 12.9531L16.2634 14.4449C16.6792 16.0928 15.6643 17.7617 13.9964 18.1725L6.95006 19.9084C5.28223 20.3192 3.59309 19.3164 3.17725 17.6686L2.80078 16.1767Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.75 5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.30391 10.5L3 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13.5" cy="7.25" r="1" fill="currentColor" />
      <circle cx="9" cy="9.25" r="1" fill="currentColor" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
    </CentralIcon>
  );
});
