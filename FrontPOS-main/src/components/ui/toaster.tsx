import React, { useEffect, useRef } from "react"
import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { playNotificationSound } from "@/lib/audio-utils"

export function Toaster() {
  const { toasts } = useToast()
  const prevToastsCount = useRef(toasts.length)

  useEffect(() => {
    if (toasts.length > prevToastsCount.current) {
      const latestToast = toasts[toasts.length - 1]
      const variant = (latestToast as any).variant || 'info'
      const soundType = variant === 'destructive' ? 'error' : 
                        variant === 'success' ? 'success' : 'info'
      playNotificationSound(soundType)
    }
    prevToastsCount.current = toasts.length
  }, [toasts])

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
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
