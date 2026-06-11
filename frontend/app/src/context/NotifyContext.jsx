import { createContext, useContext, useState, useCallback, useRef } from 'react'

const NotifyContext = createContext(null)

export function NotifyProvider({ children }) {
  const [items, setItems] = useState([])
  const idRef = useRef(0)

  const notify = useCallback((text, type = 'info') => {
    const id = ++idRef.current
    setItems(prev => [...prev, { id, text, type, visible: false }])
    // trigger visible on next frame
    requestAnimationFrame(() => {
      setItems(prev => prev.map(n => n.id === id ? { ...n, visible: true } : n))
    })
    setTimeout(() => {
      setItems(prev => prev.map(n => n.id === id ? { ...n, visible: false } : n))
      setTimeout(() => {
        setItems(prev => prev.filter(n => n.id !== id))
      }, 300)
    }, 4000)
  }, [])

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <Notifications items={items} />
    </NotifyContext.Provider>
  )
}

export function useNotify() {
  return useContext(NotifyContext)
}

function Notifications({ items }) {
  if (!items.length) return null
  return (
    <div id="notifications">
      {items.map(n => (
        <div
          key={n.id}
          className={`notification notification--${n.type}${n.visible ? ' notification--visible' : ''}`}
        >
          {n.text}
        </div>
      ))}
    </div>
  )
}
