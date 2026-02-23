import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-br from-[#6C5CE7] to-[#A29BFE] text-white shadow-[0_4px_15px_rgba(108,92,231,0.3)] hover:shadow-[0_8px_25px_rgba(108,92,231,0.4)] hover:-translate-y-0.5 border-none font-semibold tracking-wide",
        destructive:
          "bg-[#FF6B6B] text-white shadow-sm hover:bg-[#FF5252]",
        outline:
          "border border-white/10 bg-transparent text-[#F0F0F5] hover:bg-white/5 hover:border-[#6C5CE7]/50 hover:text-[#A29BFE]",
        secondary:
          "bg-[#00D2FF] text-black font-bold shadow-[0_4px_15px_rgba(0,210,255,0.3)] hover:bg-[#33E0FF]",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    (<Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />)
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }