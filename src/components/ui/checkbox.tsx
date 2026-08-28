import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border border-line-strong bg-surface",
      "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
      "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator asChild>
      <Check size={11} strokeWidth={2.4} className="text-on-accent" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";
