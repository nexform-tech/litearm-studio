import { Toaster } from 'sonner'
import { useTheme } from '@/lib/theme'

/** 应用级通知条：跟随当前主题，深色下不再是刺眼的白底卡片。 */
export function ThemedToaster() {
  const { theme } = useTheme()
  return <Toaster richColors closeButton position="top-right" offset={16} theme={theme} />
}
