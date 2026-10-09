import { useCallback, useEffect, useRef, useState } from 'react'
import { formatArmError } from '@/lib/arm/errors'
import { gripperClient } from '@/lib/arm/gripperClient'
import type { BrowseEntry } from '@/lib/arm/gripperClient'

export type GripperBrowseVm = ReturnType<typeof useGripperBrowse>

/**
 * 从"所输路径"推出起始目录：它的**上级目录**。
 *
 * 局部小工具，不进 `gripperClient` —— 它只服务这个对话框的起始位置。取不到上级
 * （空串、或根本没有 `/`）就返回 `undefined`，让 daemon 落到家目录。
 */
export function dirOf(path: string): string | undefined {
  const trimmed = path.trim()
  const cut = trimmed.lastIndexOf('/')
  if (cut <= 0) return undefined
  return trimmed.slice(0, cut)
}

/**
 * 浏览对话框独占的临时状态。
 *
 * 刻意**不**塞进已经很肥的 `useGripperSettings`：这个状态只在对话框打开期间有意义，
 * 关掉就该丢，混进设置页的 VM 只会让两边都难读。列目录是**控制机**的文件系统问题，
 * 免连接（daemon 侧 `gripper.list_dir` 同理），所以这里不关心连接状态。
 *
 * 错误**内联**在对话框里显示，不走 toast —— 它属于这一次导航，不是一次操作结果，
 * 而且不占用设置页那个共用的 `'gripper-settings-error'` toast id。
 */
export function useGripperBrowse(open: boolean, initialPath?: string) {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  /** 这一层里没列出来的普通文件数 —— 见 `BrowseListing.skippedFiles`。 */
  const [skippedFiles, setSkippedFiles] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 递增的请求 id：只有**最新**一次导航的返回被采纳，迟到的（乱序）返回直接丢弃。
  const reqId = useRef(0)

  const navigate = useCallback(async (path: string) => {
    const id = ++reqId.current
    setError('')
    setLoading(true)
    try {
      const listing = await gripperClient.listDir(path || undefined)
      if (id !== reqId.current) return
      setDir(listing.path)
      setParent(listing.parent)
      setEntries(listing.entries)
      setTruncated(listing.truncated)
      setSkippedFiles(Number(listing.skippedFiles) || 0)
    } catch (err) {
      if (id !== reqId.current) return
      setError(formatArmError(err) || String(err))
      setEntries([])
      setTruncated(false)
      setSkippedFiles(0)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [])

  // 打开时导航到起始目录；关闭时作废在途请求，免得它的返回在下次打开后落地。
  const initialRef = useRef(initialPath)
  initialRef.current = initialPath
  useEffect(() => {
    if (!open) {
      reqId.current++
      return
    }
    void navigate(initialRef.current ?? '')
  }, [open, navigate])

  const up = useCallback(() => {
    if (parent) void navigate(parent)
  }, [parent, navigate])

  const reload = useCallback(() => {
    void navigate(dir ?? '')
  }, [dir, navigate])

  return {
    dir,
    parent,
    entries,
    truncated,
    skippedFiles,
    loading,
    error,
    navigate: (path: string) => void navigate(path),
    up,
    reload,
  }
}
