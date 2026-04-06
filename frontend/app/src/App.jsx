import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { AppProvider } from './context/AppContext.jsx'
import { NotifyProvider } from './context/NotifyContext.jsx'
import Layout from './components/layout/Layout.jsx'
import LoginForm from './components/layout/LoginForm.jsx'
import StatsPage from './pages/stats/StatsPage.jsx'
import MonitorPage from './pages/monitor/MonitorPage.jsx'
import ShipmentsPage from './pages/shipments/ShipmentsPage.jsx'
import SettingsPage from './pages/settings/SettingsPage.jsx'
import ConsolidationPage from './pages/consolidation/ConsolidationPage.jsx'
import ConsolidationFormPage from './pages/consolidation/ConsolidationFormPage.jsx'
import DocsPage from './pages/docs/DocsPage.jsx'
import AnalysisPage from './pages/analysis/AnalysisPage.jsx'
import ReceivePage from './pages/receive/ReceivePage.jsx'
import ReportsPage from './pages/reports/ReportsPage.jsx'

function PlaceholderPage({ title }) {
  return (
    <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 14 }}>
      {title} — раздел в разработке
    </div>
  )
}

function ProtectedRoute({ children, module }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <LoginForm />
  if (module && !(user?.modules || []).includes(module)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 15 }}>
        Нет доступа к этому разделу
      </div>
    )
  }
  return children
}

function ModuleRoute({ module, children }) {
  const { user } = useAuth()
  const modules = user?.modules || []
  const isPrivileged = user?.role === 'admin' || user?.role === 'developer'
  // admin и developer всегда имеют доступ к настройкам, чтобы не заблокировать себя
  if (module === 'settings' && isPrivileged) return children
  if (!modules.includes(module)) return <Navigate to="/" replace />
  return children
}

function AppRoutes() {
  const { user, loading } = useAuth()

  if (loading) return null
  if (!user) return <LoginForm />

  return (
    <NotifyProvider>
      <AppProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<StatsPage />} />
            <Route path="/monitor" element={<ModuleRoute module="monitor"><MonitorPage /></ModuleRoute>} />
            <Route path="/analysis" element={<ModuleRoute module="analysis"><AnalysisPage /></ModuleRoute>} />
            <Route path="/consolidation" element={<ModuleRoute module="consolidation"><ConsolidationPage /></ModuleRoute>} />
            <Route path="/docs" element={<ModuleRoute module="docs"><DocsPage /></ModuleRoute>} />
            <Route path="/shipments" element={<ModuleRoute module="shipments"><ShipmentsPage /></ModuleRoute>} />
            <Route path="/settings" element={<ModuleRoute module="settings"><SettingsPage /></ModuleRoute>} />
            <Route path="/reports" element={<ModuleRoute module="reports"><ReportsPage /></ModuleRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
    </NotifyProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/consolidation-form" element={<ProtectedRoute module="consolidation_form"><ConsolidationFormPage /></ProtectedRoute>} />
          <Route path="/receive" element={<ProtectedRoute module="receive"><ReceivePage /></ProtectedRoute>} />
          <Route path="/*" element={<AppRoutes />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
