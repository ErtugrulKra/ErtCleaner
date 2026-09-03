import type { ErtCleanerAPI } from '../../../preload/index'

declare global {
  interface Window {
    ertcleaner: ErtCleanerAPI
  }
}

export const api = window.ertcleaner
