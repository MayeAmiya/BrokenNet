import { ref, readonly } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

let nextId = 0

const toasts = ref<ToastItem[]>([])

export function useToast() {
  function show(message: string, type: ToastType = 'info', duration = 2000): void {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
  }

  function success(message: string): void {
    show(message, 'success')
  }

  function error(message: string): void {
    show(message, 'error', 3000)
  }

  return { toasts: readonly(toasts), show, success, error }
}
