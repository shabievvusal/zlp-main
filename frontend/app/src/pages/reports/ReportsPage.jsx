import { useState } from 'react'
import HourlyReport from './HourlyReport.jsx'
import s from './ReportsPage.module.css'

const REPORT_TABS = [
  { key: 'hourly', label: 'Отчёт каждый час' },
]

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('hourly')

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Отчёты</h1>
        <div className={s.tabs}>
          {REPORT_TABS.map(tab => (
            <button
              key={tab.key}
              className={s.tab + (activeTab === tab.key ? ' ' + s.tabActive : '')}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className={s.content}>
        {activeTab === 'hourly' && <HourlyReport />}
      </div>
    </div>
  )
}
