"use client"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { CheckCircle2, Info, AlertTriangle, XCircle } from "lucide-react"

/**
 * Ikona po varianti (POS jezik obvestil): uspeh ✓, opozorilo ⚠, napaka ✕,
 * informacija ℹ. Dekorativna (aria-hidden) — pomen je v besedilu naslova,
 * ikona je samo vizualni pospešek skeniranja. */
const TOAST_ICONS: Record<string, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
  info: Info,
}

const TOAST_ICON_CLS: Record<string, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  destructive: "text-white",
  info: "text-sky-600 dark:text-sky-400",
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const Icon = TOAST_ICONS[props.variant ?? "default"]
        return (
          <Toast key={id} {...props}>
            {Icon && (
              <Icon
                data-slot="toast-icon"
                aria-hidden="true"
                className={`size-5 shrink-0 ${TOAST_ICON_CLS[props.variant ?? "default"] ?? ""}`}
              />
            )}
            <div className="grid flex-1 gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}