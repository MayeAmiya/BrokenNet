import type { LauncherAPI } from './index'

declare global {
  interface Window {
    api: LauncherAPI
  }
}

export {}
