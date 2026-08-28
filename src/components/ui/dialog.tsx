import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showClose?: boolean }
>(({ className, children, showClose = true, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* data-tw-portal: o reset base em app.css não alcança portals do Radix sem isso. */}
    <DialogPrimitive.Overlay
      data-tw-portal
      className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--overlay)] p-6"
    >
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "relative flex w-full max-h-[80vh] flex-col gap-4 overflow-auto rounded-lg border border-line-strong bg-surface p-5 shadow-pop",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label="Fechar"
            className="absolute right-3.5 top-3.5 flex h-7 w-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2"
          >
            <X size={15} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("font-display text-[15px] font-semibold -tracking-[0.01em]", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-xs leading-relaxed text-faint", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2.5", className)} {...props} />;
}
