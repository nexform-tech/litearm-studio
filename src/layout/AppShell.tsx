import { Outlet } from 'react-router-dom'
import { RailNav } from './RailNav'
import { TopBar } from './TopBar'

/**
 * Ports the mockup's fixed 1920x1080 "canvas card" shell as a real full-viewport
 * page: rail on the left, header on top, routed page content filling the rest.
 */
export function AppShell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--app-bg)]">
      <RailNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
