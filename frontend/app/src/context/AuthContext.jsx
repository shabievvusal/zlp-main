import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../api/index.js'

const LS_ACCESS_KEY  = 'wms_access_token'
const LS_EXPIRY_KEY  = 'wms_access_token_expiry'
const LS_REFRESH_KEY = 'wms_refresh_token'
const EXPIRY_MARGIN  = 60_000

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  // in-memory токен — как в оригинальном auth.js
  const accessTokenRef       = useRef(null)
  const accessTokenExpiryRef = useRef(null)
  const refreshTokenRef      = useRef(null)
  const refreshTimerRef      = useRef(null)
  const retryCountRef        = useRef(0)

  function saveAccessToken(token, expiryMs) {
    accessTokenRef.current       = token
    accessTokenExpiryRef.current = expiryMs || null
    try {
      if (token) {
        localStorage.setItem(LS_ACCESS_KEY, token)
        localStorage.setItem(LS_EXPIRY_KEY, String(expiryMs || 0))
      } else {
        localStorage.removeItem(LS_ACCESS_KEY)
        localStorage.removeItem(LS_EXPIRY_KEY)
      }
    } catch { /* ignore */ }
  }

  function saveRefreshToken(token) {
    refreshTokenRef.current = token
    try {
      if (token) localStorage.setItem(LS_REFRESH_KEY, token)
      else        localStorage.removeItem(LS_REFRESH_KEY)
    } catch { /* ignore */ }
  }

  function clearTokens() {
    saveAccessToken(null, null)
    saveRefreshToken(null)
  }

  /** Как auth.getToken() в оригинале */
  function getToken() {
    return accessTokenRef.current
  }

  /** Как auth.isTokenValid() в оригинале */
  function isTokenValid() {
    if (!accessTokenRef.current) return false
    if (!accessTokenExpiryRef.current) return true
    return Date.now() < accessTokenExpiryRef.current - EXPIRY_MARGIN
  }

  const doRefresh = useCallback(async () => {
    if (!refreshTokenRef.current) return false
    try {
      const data = await api.refreshSamokatToken(refreshTokenRef.current)
      const val  = data?.value ?? data
      if (!val?.accessToken) return false
      const expiry = Date.now() + (val.expiresIn || 300) * 1000
      saveAccessToken(val.accessToken, expiry)
      if (val.refreshToken) saveRefreshToken(val.refreshToken)
      await api.putConfig({ token: val.accessToken, refreshToken: refreshTokenRef.current })
      return true
    } catch {
      return false
    }
  }, [])

  const scheduleRefresh = useCallback((expiryMs) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    if (!expiryMs) return
    const delay = Math.max(10_000, expiryMs - Date.now() - EXPIRY_MARGIN)
    refreshTimerRef.current = setTimeout(async () => {
      const ok = await doRefresh()
      if (ok) {
        retryCountRef.current = 0
        scheduleRefresh(accessTokenExpiryRef.current)
      } else {
        retryCountRef.current += 1
        const retryDelay = Math.min(retryCountRef.current * 30_000, 10 * 60_000)
        refreshTimerRef.current = setTimeout(() => scheduleRefresh(expiryMs), retryDelay)
      }
    }, delay)
  }, [doRefresh])

  const restore = useCallback(async () => {
    setLoading(true)
    try {
      const me = await api.getVsMe()
      setUser(me || null)
      if (!me) return

      if (me.allowWithoutToken) return

      // Восстанавливаем access-токен из localStorage (если не истёк)
      const storedAccess = localStorage.getItem(LS_ACCESS_KEY)
      const storedExpiry = parseInt(localStorage.getItem(LS_EXPIRY_KEY) || '0', 10)
      if (storedAccess && storedExpiry > Date.now() + EXPIRY_MARGIN) {
        saveAccessToken(storedAccess, storedExpiry)
        const storedRefresh = localStorage.getItem(LS_REFRESH_KEY)
        if (storedRefresh) saveRefreshToken(storedRefresh)
        scheduleRefresh(storedExpiry)
        return
      }

      // Access истёк — пробуем refresh
      const storedRefresh = localStorage.getItem(LS_REFRESH_KEY)
      if (!storedRefresh) return
      saveRefreshToken(storedRefresh)
      const ok = await doRefresh()
      if (ok) {
        retryCountRef.current = 0
        scheduleRefresh(accessTokenExpiryRef.current)
      }
    } finally {
      setLoading(false)
    }
  }, [doRefresh, scheduleRefresh])

  useEffect(() => { restore() }, [restore])

  const login = useCallback(async (loginValue, password) => {
    const data = await api.loginVs(loginValue, password)
    setUser(data.user || data)
    if (data.accessToken) {
      const expiry = Date.now() + (data.expiresIn || 300) * 1000
      saveAccessToken(data.accessToken, expiry)
      saveRefreshToken(data.refreshToken || null)
      // Сохраняем токен в конфиг бэкенда — как в оригинальном auth.js
      await api.putConfig({ token: data.accessToken, refreshToken: data.refreshToken || '' })
      scheduleRefresh(expiry)
    }
    return data
  }, [scheduleRefresh])

  const logout = useCallback(async () => {
    await api.logoutVs()
    setUser(null)
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    clearTokens()
  }, [])

  const forceRefresh = useCallback(() => doRefresh(), [doRefresh])

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.getVsMe()
      setUser(me || null)
    } catch { /* ignore */ }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, restore, login, logout, getToken, isTokenValid, forceRefresh, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
