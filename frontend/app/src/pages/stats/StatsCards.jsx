import { Package, ClipboardList, Hash, Scale, HardHat, Calendar } from 'lucide-react'
import { formatWeight, shiftLabel } from '../../utils/format.js'
import styles from './StatsPage.module.css'

function StatCard({ Icon, value, label, green, valueSm }) {
  return (
    <div className={`${styles.statCard} ${green ? styles.statCardGreen : ''}`}>
      <div className={styles.statIcon}>
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div className={`${styles.statValue} ${valueSm ? styles.statValueSm : ''}`}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

export default function StatsCards({ stats, selectedDate, shiftFilter }) {
  if (!stats) return null

  const totalStorage = (stats.hourly || []).reduce((s, h) => s + (h.storageOps || 0), 0)

  return (
    <div className={styles.statsCards}>
      <StatCard Icon={Package}       value={(stats.totalOps || 0).toLocaleString('ru-RU')}              label="Операций" />
      <StatCard Icon={ClipboardList} value={totalStorage.toLocaleString('ru-RU')}                        label="Задач (хранение)" />
      <StatCard Icon={Hash}          value={(stats.totalQty || 0).toLocaleString('ru-RU')}               label="Единиц товара" green />
      <StatCard Icon={Scale}         value={formatWeight(stats.totalWeightStorageGrams || 0)}            label="Вес (хранение)" />
      <StatCard Icon={Scale}         value={formatWeight(stats.totalWeightKdkGrams || 0)}                label="Вес (КДК)" />
      <StatCard Icon={Scale}         value={formatWeight(stats.totalWeightGrams || 0)}                   label="Вес итог" />
      <StatCard Icon={HardHat}       value={(stats.executors || []).length}                              label="Сотрудников" />
      <StatCard Icon={Calendar}      value={shiftLabel(selectedDate, shiftFilter)}                       label="Дата" valueSm />
    </div>
  )
}
