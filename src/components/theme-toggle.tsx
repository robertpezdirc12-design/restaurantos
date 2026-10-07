'use client'

import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Preklop svetlega/temnega načina (next-themes, class strategija).
 * Ikoni sta vedno obe v DOM — vidnost ureja CSS prek .dark razreda,
 * zato ni hidracijskega neskladja in ni potreben "mounted" state.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      variant="outline"
      size="icon"
      className={`shrink-0 ${className}`}
      aria-label="Preklopi svetli/temni način"
      title="Svetli / temni način"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="hidden dark:block w-4 h-4" />
      <Moon className="block dark:hidden w-4 h-4" />
    </Button>
  )
}
