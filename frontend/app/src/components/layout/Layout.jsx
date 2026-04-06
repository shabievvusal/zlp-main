import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import styles from './Layout.module.css'
import {
  BarChart2, Monitor, TrendingUp, Package, FileText,
  Truck, ClipboardList, Settings, LogOut, ChevronLeft,
  ChevronRight, UserCircle,
} from 'lucide-react'

const NAV_ITEMS = [
  { to: '/',               Icon: BarChart2,     label: 'Статистика',   module: 'stats' },
  { to: '/monitor',        Icon: Monitor,       label: 'Мониторинг',   module: 'monitor' },
  { to: '/analysis',       Icon: TrendingUp,    label: 'Анализ',       module: 'analysis' },
  { to: '/consolidation',  Icon: Package,       label: 'Консолидация', module: 'consolidation' },
  { to: '/docs',           Icon: FileText,      label: 'Документы',    module: 'docs' },
  { to: '/shipments',      Icon: Truck,         label: 'Отгрузка',     module: 'shipments' },
  { to: '/reports',        Icon: ClipboardList, label: 'Отчёты',       module: 'reports' },
  { to: '/settings',       Icon: Settings,      label: 'Настройки',    module: 'settings' },
]

const LS_KEY = 'sidebar_collapsed'

export default function Layout() {
  const { user, logout } = useAuth()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LS_KEY) === '1')
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  const toggle = () => setCollapsed(v => {
    const next = !v
    localStorage.setItem(LS_KEY, next ? '1' : '0')
    return next
  })

  // Закрыть попап при клике вне
  useEffect(() => {
    if (!userMenuOpen) return
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [userMenuOpen])

  const userModules = user?.modules || []
  const visibleNav = NAV_ITEMS.filter(
    item => !item.module || item.module === 'stats' || userModules.includes(item.module)
  )
  const isDeveloper = user?.role === 'developer'
  const userName = user?.name || user?.role || ''

  return (
    <div className={styles.app}>
      {/* ── Sidebar ── */}
      <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>

        {isDeveloper && (
          <div className={styles.devBanner}>
            {collapsed ? '⚡' : '⚡ Режим разработчика'}
          </div>
        )}

        {/* Brand */}
        <div className={styles.brand}>
          <img src="/icon.png" alt="logo" className={styles.brandIcon} />
          {!collapsed && (
            <div className={styles.brandText}>
              <div className={styles.brandName}>СберЛогистика</div>
              <div className={styles.brandSub}>WMS Мониторинг</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className={styles.nav}>
          {visibleNav.map(({ to, Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `${styles.navBtn}${isActive ? ' ' + styles.navBtnActive : ''}${collapsed ? ' ' + styles.navBtnCollapsed : ''}`
              }
              title={collapsed ? label : undefined}
            >
              <Icon size={17} className={styles.navIcon} strokeWidth={1.75} />
              {!collapsed && <span className={styles.navLabel}>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer: user menu + toggle */}
        <div className={styles.sidebarFooter} ref={userMenuRef}>
          {user && (
            <>
              <button
                className={`${styles.userBtn} ${collapsed ? styles.userBtnCollapsed : ''}`}
                onClick={() => setUserMenuOpen(v => !v)}
                title={collapsed ? userName : undefined}
              >
                <div className={styles.userAvatar}>
                  <UserCircle size={18} strokeWidth={1.75} />
                </div>
                {!collapsed && (
                  <span className={styles.userName}>{userName}</span>
                )}
              </button>

              {/* Popup */}
              {userMenuOpen && (
                <div className={`${styles.userPopup} ${collapsed ? styles.userPopupCollapsed : ''}`}>
                  <div className={styles.userPopupName}>{userName}</div>
                  <div className={styles.userPopupDivider} />
                  <button
                    className={styles.userPopupLogout}
                    onClick={() => { setUserMenuOpen(false); logout() }}
                  >
                    <LogOut size={14} strokeWidth={2} />
                    Выйти из аккаунта
                  </button>
                </div>
              )}
            </>
          )}

          {/* Toggle arrow */}
          <button className={styles.toggleBtn} onClick={toggle} title={collapsed ? 'Развернуть' : 'Свернуть'}>
            {collapsed
              ? <ChevronRight size={13} strokeWidth={2.5} />
              : <ChevronLeft  size={13} strokeWidth={2.5} />
            }
          </button>
        </div>
      </aside>

      {/* ── Mobile top header ── */}
      <header className={styles.mobileHeader}>
        <div className={styles.mobileBrand}>
          <img src="/icon.png" alt="logo" className={styles.mobileBrandIcon} />
          <span className={styles.mobileBrandName}>СберЛогистика WMS</span>
        </div>
        {user && <span className={styles.mobileUser}>{userName}</span>}
      </header>

      {/* ── Main ── */}
      <main className={styles.main}>
        <Outlet />
      </main>

      {/* ── Bottom nav (mobile) ── */}
      <nav className={styles.bottomNav}>
        {visibleNav.map(({ to, Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              styles.bottomNavBtn + (isActive ? ' ' + styles.bottomNavBtnActive : '')
            }
          >
            <Icon size={20} strokeWidth={1.75} className={styles.bottomNavIcon} />
            <span className={styles.bottomNavLabel}>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
