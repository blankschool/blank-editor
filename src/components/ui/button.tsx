import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:opacity-90",
        outline: "border border-line bg-surface-2 text-muted hover:text-text hover:border-line-strong",
        ghost: "text-muted hover:bg-surface-2 hover:text-text",
        danger: "bg-danger text-white hover:opacity-90",
        dangerGhost: "border border-line bg-surface-2 text-danger hover:border-line-strong",
      },
      size: {
        default: "h-8 px-3.5 text-xs",
        sm: "h-6.5 px-2.5 text-[11px]",
        md: "h-8.5 px-3.5 text-xs",
        lg: "h-10 px-4 text-[13px]",
        xl: "h-11.5 px-4 text-sm",
        icon: "h-6.5 w-6.5 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
