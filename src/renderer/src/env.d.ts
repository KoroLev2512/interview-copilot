import type { CopilotApi } from '../../../electron/preload/index'

declare global {
  interface Window {
    copilot: CopilotApi
  }
}

export {}
