import { NavLink } from 'react-router-dom'
import { Activity, CircleDot, Languages, Moon, Settings, Sun } from 'lucide-react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'

const RAIL_ITEMS: {
  to: string
  navKey: 'control' | 'log' | 'settings'
  icon: ComponentType<{ size?: number | string; color?: string }>
}[] = [
  { to: '/control', navKey: 'control', icon: CircleDot },
  { to: '/log', navKey: 'log', icon: Activity },
  { to: '/settings', navKey: 'settings', icon: Settings },
]

const railItemClass = 'flex w-[3.75rem] flex-col items-center gap-1 rounded-[0.6875rem] py-[0.5625rem] no-underline transition-colors hover:bg-[#222c3a]'

export function RailNav() {
  const { t, i18n } = useTranslation('nav')
  const { theme, toggleTheme } = useTheme()

  const toggleLanguage = () => {
    const nextLang = i18n.language.startsWith('en') ? 'zh' : 'en'
    i18n.changeLanguage(nextLang)
  }

  // 与语言按钮一致：图标/文字显示的是「点击后会切换到」的那一侧。
  const toDark = theme === 'light'
  const ThemeIcon = toDark ? Moon : Sun

  return (
    <div className="flex w-20 flex-none basis-20 flex-col items-center gap-1.5 bg-[#141b26] px-0 pt-3.5 pb-3">
      <img src="/logo.svg" alt="Logo" className="mb-3 h-5 w-auto brightness-0 invert" />

      {RAIL_ITEMS.map((r) => {
        const Icon = r.icon
        return (
          <NavLink
            key={r.to}
            to={r.to}
            className={({ isActive }) => cn(railItemClass, isActive && 'bg-[#2a3444] hover:bg-[#2a3444]')}
          >
            {({ isActive }) => (
              <>
                <Icon size="1.25rem" color={isActive ? '#fff' : '#8b97a6'} />
                <div className={cn('text-[0.65625rem] font-semibold text-center leading-tight', isActive ? 'text-white' : 'text-[#8b97a6]')}>
                  {t(r.navKey)}
                </div>
              </>
            )}
          </NavLink>
        )
      })}

      <div className="flex-1" />

      <button
        type="button"
        id="rail-theme-toggle"
        onClick={toggleTheme}
        title={toDark ? t('themeToDark') : t('themeToLight')}
        aria-label={toDark ? t('themeToDark') : t('themeToLight')}
        aria-pressed={theme === 'dark'}
        className={cn(railItemClass, 'cursor-pointer')}
      >
        <ThemeIcon size="1.25rem" color="#8b97a6" />
        <div className="text-[0.65625rem] font-semibold text-center leading-tight text-[#8b97a6]">
          {toDark ? t('themeDarkLabel') : t('themeLightLabel')}
        </div>
      </button>

      <button
        type="button"
        onClick={toggleLanguage}
        title={i18n.language.startsWith('en') ? '切换为中文' : 'Switch to English'}
        className={cn(railItemClass, 'cursor-pointer')}
      >
        <Languages size="1.25rem" color="#8b97a6" />
        <div className="text-[0.65625rem] font-semibold text-center leading-tight text-[#8b97a6]">
          {i18n.language.startsWith('en') ? 'EN' : '中文'}
        </div>
      </button>
    </div>
  )
}
