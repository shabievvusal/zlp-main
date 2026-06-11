import { useState } from 'react'
import { formatWeight } from '../../utils/format.js'
import * as api from '../../api/index.js'
import styles from './StatsPage.module.css'

const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']

function getDefaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthlyCompanySummaryTable() {
  const [month, setMonth] = useState(getDefaultMonth)
  const [shift, setShift] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (!month) return
    const [year, mon] = month.split('-')
    setLoading(true)
    try {
      const res = await api.getMonthlyCompany(year, mon, shift || undefined)
      setData(res)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const totals = data?.companies?.reduce((acc, c) => {
    acc.totalTasks          += c.totalTasks || 0
    acc.storageOps          += c.storageOps || 0
    acc.kdkOps              += c.kdkOps || 0
    acc.weightTotalGrams    += c.weightTotalGrams || 0
    acc.weightStorageGrams  += c.weightStorageGrams || 0
    acc.weightKdkGrams      += c.weightKdkGrams || 0
    return acc
  }, { totalTasks: 0, storageOps: 0, kdkOps: 0, weightTotalGrams: 0, weightStorageGrams: 0, weightKdkGrams: 0 })

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <span>Сводка по компаниям за месяц</span>
          <span className={styles.cardHeaderSub}> Итог СЗ, сотрудников, рабочих дней</span>
        </div>
        <div className={styles.monthlyControls}>
          <input
            type="month"
            className={styles.selectControl}
            style={{ fontSize: 13 }}
            value={month}
            onChange={e => setMonth(e.target.value)}
          />
          <select
            className={styles.selectControl}
            style={{ fontSize: 13 }}
            value={shift}
            onChange={e => setShift(e.target.value)}
          >
            <option value="">Все смены</option>
            <option value="day">День (9–21)</option>
            <option value="night">Ночь (21–9)</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? '...' : 'Загрузить'}
          </button>
        </div>
      </div>

      {!data && (
        <div className={styles.emptyRow}>Выберите месяц и нажмите «Загрузить»</div>
      )}
      {data && !data.companies?.length && (
        <div className={styles.emptyRow}>Нет данных за выбранный период</div>
      )}
      {data?.companies?.length > 0 && (
        <>
          {data.month && (
            <div style={{ padding: '8px 12px 4px', fontSize: 12, color: 'var(--text-muted)' }}>
              {MONTH_NAMES[data.month - 1]} {data.year} · {data.daysInMonth} дней
            </div>
          )}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Компания</th>
                  <th className={styles.tdCenter}>Сотрудников</th>
                  <th className={styles.tdCenter}>Раб. дней</th>
                  <th className={styles.tdCenter} title="Среднее задач в день на сотрудника">СЗ/Д</th>
                  <th className={styles.tdCenter} title="Средний вес в день на сотрудника">ВЕС/Д</th>
                  <th className={styles.tdCenter}>Итог</th>
                  <th className={styles.tdCenter}>Вес итог</th>
                  <th className={styles.tdCenter} title="СЗ в хранении">СЗ хранение</th>
                  <th className={styles.tdCenter} title="СЗ в КДК">СЗ КДК</th>
                  <th className={styles.tdCenter}>Вес хранение</th>
                  <th className={styles.tdCenter}>Вес КДК</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map(c => {
                  const szd  = c.workDays > 0 && c.employees > 0
                    ? Math.round(c.totalTasks / c.employees / c.workDays) : 0
                  const vezd = c.workDays > 0 && c.employees > 0
                    ? Math.round(c.weightTotalGrams / c.employees / c.workDays) : 0
                  return (
                    <tr key={c.name}>
                      <td className={styles.tdBold}>{c.name}</td>
                      <td className={styles.tdCenter}>{c.employees}</td>
                      <td className={styles.tdCenter}>{c.workDays}</td>
                      <td className={styles.tdCenter}>{szd}</td>
                      <td className={styles.tdCenter}>{formatWeight(vezd)}</td>
                      <td className={`${styles.tdCenter} ${styles.tdBold}`}>{c.totalTasks.toLocaleString('ru-RU')}</td>
                      <td className={styles.tdCenter}>{formatWeight(c.weightTotalGrams)}</td>
                      <td className={styles.tdCenter}>{c.storageOps.toLocaleString('ru-RU')}</td>
                      <td className={styles.tdCenter}>{c.kdkOps.toLocaleString('ru-RU')}</td>
                      <td className={styles.tdCenter}>{formatWeight(c.weightStorageGrams)}</td>
                      <td className={styles.tdCenter}>{formatWeight(c.weightKdkGrams)}</td>
                    </tr>
                  )
                })}
                <tr className={styles.totalRow}>
                  <td className={styles.tdBold}>ИТОГО</td>
                  <td /><td /><td /><td />
                  <td className={`${styles.tdCenter} ${styles.tdBold}`}>{totals.totalTasks.toLocaleString('ru-RU')}</td>
                  <td className={styles.tdCenter}>{formatWeight(totals.weightTotalGrams)}</td>
                  <td className={styles.tdCenter}>{totals.storageOps.toLocaleString('ru-RU')}</td>
                  <td className={styles.tdCenter}>{totals.kdkOps.toLocaleString('ru-RU')}</td>
                  <td className={styles.tdCenter}>{formatWeight(totals.weightStorageGrams)}</td>
                  <td className={styles.tdCenter}>{formatWeight(totals.weightKdkGrams)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={styles.formulas}>
            <span>СЗ/Д = Итог ÷ Сотрудников ÷ Раб. дней</span>
            <span>ВЕС/Д = Вес итог ÷ Сотрудников ÷ Раб. дней</span>
          </div>
        </>
      )}
    </div>
  )
}
