import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        /* Statusne variante (POS jezik stanj — Toast/Square vzorec): mehke
           pastelne ploskve z nasičenim besedilom. emerald/amber žetone temna
           plast v globals.css ŽE preslikava (.dark .bg-emerald-50 …) — badge
           je zato avtomatsko pravilen v obeh načinih. sky preslikave NI,
           zato ima info izrecne dark: razrede (samozadosten, brez posega v
           skupno plast — ta je pod gate-i v179). */
        success:
          "border-emerald-200 bg-emerald-50 text-emerald-800 [a&]:hover:bg-emerald-100",
        warning:
          "border-amber-200 bg-amber-50 text-amber-800 [a&]:hover:bg-amber-100",
        info:
          "border-sky-200 bg-sky-50 text-sky-800 [a&]:hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300 dark:[a&]:hover:bg-sky-900",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
