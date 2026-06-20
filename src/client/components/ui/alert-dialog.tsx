import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import * as React from "react";
import { cn } from "../../lib/utils";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogClose = AlertDialogPrimitive.Close;
const AlertDialogTitle = AlertDialogPrimitive.Title;
const AlertDialogDescription = AlertDialogPrimitive.Description;

function AlertDialogPopup({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Popup>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/72 backdrop-blur-md data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <AlertDialogPrimitive.Popup
          className={cn(
            "relative flex w-full max-w-[512px] flex-col overflow-hidden rounded-[16px] border border-white/[0.12] bg-[#202020] text-white shadow-[0_28px_90px_rgb(0_0_0/0.62)] outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Popup>
      </div>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("flex flex-col gap-3 px-6 py-6", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("flex items-center justify-end gap-4 border-t border-white/[0.08] bg-white/[0.035] px-6 py-4", className)} {...props} />;
}

export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
};
