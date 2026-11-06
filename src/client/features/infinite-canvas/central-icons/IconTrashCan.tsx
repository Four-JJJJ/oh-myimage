import { forwardRef, type SVGProps } from "react";
import { CentralIcon } from "./icon";

export const IconTrashCan = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function IconTrashCan(props, ref) {
  return (
    <CentralIcon ref={ref} {...props}>
      <path d="M4.75 6.5L5.58982 18.4601C5.70016 20.0316 7.00714 21.25 8.58245 21.25H15.4175C16.9929 21.25 18.2998 20.0316 18.4102 18.4601L19.25 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.25 5.75H20.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.52466 5.58289C8.73085 3.84652 10.2082 2.5 12.0001 2.5C13.7919 2.5 15.2693 3.84652 15.4755 5.58289" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 10.5V16.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 10.5V16.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </CentralIcon>
  );
});
