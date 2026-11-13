import { cn } from "@/lib/utils"

/**
 * Skeleton — mehak gradientni pomet (vidi globals.css `[data-slot="skeleton"]`),
 * namesto pulziranja celotne ploščice (Toast/Square vzorec). Animacija živi
 * IZKLJUČNO v globals.css: `animate-pulse` bi bil preklican z neplasteno
 * animacijo v plasti (isti past kot v1.131.0 pri obrobah), zato tukaj ni
 * animacijskega razreda. reduced-motion varovalka v globals.css pusti
 * miren skelet (pomet je izven okvirja).
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-accent rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
