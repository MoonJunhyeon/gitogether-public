// 우클릭 메뉴 (macOS 메뉴 모양). 바깥 클릭, Esc, 스크롤, 창 전환 시 닫힘. ↑↓ Enter로도 고를 수 있다.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onSelect?: () => void; submenu?: MenuItem[] }
  | 'separator'
export type MenuState = { x: number; y: number; items: MenuItem[] }

function MenuList({ items, onClose, x, y, autoFocus }: { items: MenuItem[]; onClose: () => void; x: number; y: number; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(-1)
  const [openSub, setOpenSub] = useState(-1)
  const usable = items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0)

  // 화면 밖으로 나가지 않게 위치 보정
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(44, Math.min(y, window.innerHeight - r.height - 4)),
    })
    if (autoFocus) ref.current!.focus()
  }, [x, y])

  const choose = (i: number) => {
    const it = items[i]
    if (it === 'separator' || it.disabled) return
    if (it.submenu) return setOpenSub(i)
    onClose()
    it.onSelect?.()
  }

  return (
    <div ref={ref} className="menu" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const at = usable.indexOf(active)
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(usable[(at + 1) % usable.length]) }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive(usable[(at - 1 + usable.length) % usable.length]) }
        if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active) }
        if (e.key === 'ArrowRight' && active >= 0 && (items[active] as any).submenu) setOpenSub(active)
      }}>
      {items.map((it, i) => it === 'separator'
        ? <div key={i} className="menu-sep" role="separator" />
        : (
          <div key={i} role="menuitem" aria-disabled={it.disabled} aria-haspopup={!!it.submenu}
            className={['menu-item', it.danger && 'danger', it.disabled && 'disabled', (active === i || openSub === i) && 'active'].filter(Boolean).join(' ')}
            onMouseEnter={() => { setActive(i); setOpenSub(it.submenu ? i : -1) }}
            onClick={() => choose(i)}>
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.submenu && <ChevronRight className="menu-hint" size={14} />}
            {it.submenu && openSub === i && (
              <SubMenu items={it.submenu} onClose={onClose} />
            )}
          </div>
        ))}
    </div>
  )
}

// 하위 메뉴: 항목 오른쪽에 붙여 연다
function SubMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<{ x: number; y: number }>()
  useLayoutEffect(() => {
    const r = anchor.current!.parentElement!.getBoundingClientRect()
    setAt({ x: r.right - 4, y: r.top - 5 })
  }, [])
  return <span ref={anchor} onClick={(e) => e.stopPropagation()}>{at && <MenuList items={items} onClose={onClose} x={at.x} y={at.y} />}</span>
}

export function ContextMenu({ menu, onClose }: { menu?: MenuState; onClose: () => void }) {
  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.menu'))) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  return menu ? <MenuList key={`${menu.x},${menu.y}`} items={menu.items} onClose={onClose} x={menu.x} y={menu.y} autoFocus /> : null
}
