import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

function DialogPopup({
  className,
  children,
  showCloseButton = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & {
  showCloseButton?: boolean;
}): React.ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/72 backdrop-blur-sm data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <DialogPrimitive.Popup
          className={cn(
            "relative flex max-h-[calc(100dvh-48px)] w-full max-w-[960px] flex-col overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#191d18] text-white shadow-[0_24px_80px_rgb(0_0_0/0.58)] outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {showCloseButton && (
            <DialogPrimitive.Close className="absolute right-4 top-4 z-10 inline-flex size-8 items-center justify-center rounded-[12px] border border-transparent bg-white/[0.06] text-white/72 transition hover:bg-white/[0.1] hover:text-white">
              <X aria-hidden size={16} />
            </DialogPrimitive.Close>
          )}
          {children}
        </DialogPrimitive.Popup>
      </div>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4", className)} {...props} />;
}

function DialogPanel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("min-h-0 flex-1 overflow-auto px-5 py-5", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("flex items-center justify-end gap-2 border-t border-white/[0.08] px-5 py-4", className)} {...props} />;
}

export { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger };
