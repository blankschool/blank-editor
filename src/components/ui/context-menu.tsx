import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSeparator = ({ className, ...props }: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) => (
  <ContextMenuPrimitive.Separator className={cn("my-1 h-px bg-line", className)} {...props} />
);

export const ContextMenuContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      data-tw-portal
      className={cn(
        "z-50 flex min-w-[180px] flex-col gap-px rounded-md border border-line-strong bg-surface p-1.5 shadow-pop",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export const ContextMenuItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { danger?: boolean }
>(({ className, danger, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "cursor-pointer rounded-sm px-3 py-2 text-xs outline-none data-[highlighted]:bg-surface-2",
      danger ? "text-danger" : "text-text",
      "data-[disabled]:cursor-default data-[disabled]:text-faint data-[disabled]:data-[highlighted]:bg-transparent",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = "ContextMenuItem";
