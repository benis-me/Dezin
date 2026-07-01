import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
// editor 插件必须在 new App({editor:...}) 之前注册
// leafer-editor 的 bundle 在 Vite dev 模式下不保证 side-effect 执行
import '@leafer-in/editor'
import { App, type ILeaferConfig } from 'leafer-editor'
import * as LeaferAll from 'leafer-editor'
import { LeaferContext } from '../context/leafer-context'
import { render, unmount } from '../core/renderer'

// Resource 通过 export * 链从 leafer-editor 可达：
// leafer-editor → leafer-ui → @leafer-ui/web → @leafer/web-core → @leafer/core → @leafer/file
// TypeScript 类型声明未包含，通过 namespace import 在运行时访问
const Resource = (LeaferAll as any).Resource as
  | { tasker: any; map: Record<string, any> }
  | undefined

/**
 * 清空 Leafer 全局图片加载队列。
 *
 * Resource.tasker 是全局单例 TaskProcessor（6 并行），快速切页时旧图片任务
 * 会阻塞新图片加载。此函数暂停并清空队列，同时重置未完成图片的 loading 标记。
 */
function clearImageLoadingQueue(): void {
  try {
    if (!Resource?.tasker) return

    const tasker = Resource.tasker
    tasker.pause()
    if (tasker.timer != null) {
      clearTimeout(tasker.timer)
      tasker.timer = null
    }
    tasker.running = false
    tasker.isComplete = true
    tasker.list = []
    tasker.parallelList = []
    tasker.parallelSuccessNumber = 0
    tasker.index = 0
    tasker.delayNumber = 0

    // 重置"正在加载但未完成"的 LeaferImage 的 loading 标记
    // 防止新页面请求相同 URL 时因 loading===true 而跳过加载
    const map = Resource.map
    if (map) {
      for (const key in map) {
        const img = map[key]
        if (img && img.loading && !img.ready) {
          img.loading = false
          img.waitComplete = []
        }
      }
    }
  } catch {
    // 容错：如果 Leafer 内部结构变化，不影响页面正常运行
  }
}

export interface LeaferProps {
  view?: HTMLElement | string
  width?: number
  height?: number
  fill?: string
  editor?: boolean | Record<string, any>
  tree?: Partial<ILeaferConfig>
  wheel?: Record<string, any>
  move?: Record<string, any>
  zoom?: Record<string, any>
  children?: ReactNode
  onAppReady?: (app: App) => void
  className?: string
  style?: React.CSSProperties
}

export const Leafer: React.FC<LeaferProps> = ({
  view,
  width,
  height,
  fill,
  editor = false,
  tree,
  wheel,
  move,
  zoom,
  children,
  onAppReady,
  className,
  style,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<App | null>(null)
  const [appReady, setAppReady] = useState(false)

  // Create App
  useLayoutEffect(() => {
    const viewElement =
      typeof view === 'string'
        ? document.getElementById(view)
        : view || containerRef.current

    if (!viewElement) return

    const treeConfig: ILeaferConfig = {
      type: 'design',
      pixelSnap: true,
      pointSnap: true,
      smooth: true,
      webgl: true,
      fill,
      ...tree,
    }

    const appConfig: Record<string, any> = {
      view: viewElement,
      tree: treeConfig,
    }

    if (editor) {
      appConfig.editor =
        editor === true
          ? { hideOnMove: true, skewable: false }
          : editor
    }
    if (wheel) appConfig.wheel = wheel
    if (move) appConfig.move = move
    if (zoom) appConfig.zoom = zoom
    if (width) appConfig.width = width
    if (height) appConfig.height = height

    const app = new App(appConfig)
    appRef.current = app
    setAppReady(true)
    onAppReady?.(app)

    return () => {
      // 清空全局图片加载队列，防止旧页面图片阻塞新页面图片加载
      // 必须在 useLayoutEffect cleanup 中执行（先于新 canvas 的 useLayoutEffect）
      clearImageLoadingQueue()
      unmount(app)
      app.destroy()
      appRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconcile children — 只在 children 引用变化或 app 就绪时调用
  const prevChildrenRef = useRef<ReactNode>(undefined)
  useLayoutEffect(() => {
    if (!appReady || !appRef.current) return
    if (prevChildrenRef.current === children) return
    prevChildrenRef.current = children
    render(children, appRef.current)
  }, [appReady, children])

  // Auto-resize: watch container div with ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    const app = appRef.current
    if (!container || !app) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width: w, height: h } = entry.contentRect
      if (w > 0 && h > 0) {
        app.resize({
          width: w,
          height: h,
          pixelRatio: window.devicePixelRatio || 1,
        })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <LeaferContext.Provider value={appRef.current}>
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
      />
    </LeaferContext.Provider>
  )
}
