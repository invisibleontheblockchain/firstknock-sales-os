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
          "bg-[#2EEB57] text-black shadow-[0_4px_18px_rgba(46,235,87,0.28)] hover:bg-[#39FF4A] hover:shadow-[0_8px_28px_rgba(57,255,74,0.38)] hover:-translate-y-0.5 border-none font-semibold tracking-wide",
        destructive:
          "bg-[#FF6B6B] text-white shadow-sm hover:bg-[#FF5252]",
        outline:
          "border border-white/15 bg-transparent text-white hover:bg-[#2EEB57]/10 hover:border-[#2EEB57]/60 hover:text-[#39FF4A]",
        secondary:
          "bg-white text-black font-bold shadow-[0_4px_15px_rgba(255,255,255,0.18)] hover:bg-[#E5E7EB]",
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