import { useApp } from '../../context/AppContext.jsx'
import styles from './StatsPage.module.css'

export default function CompanyFilter() {
  const { filterCompany, setFilterCompany, emplCompanies } = useApp()

  const options = [
    { value: '__all__',  label: 'Все сотрудники' },
    ...emplCompanies.map(c => ({ value: c, label: c })),
    { value: '__none__', label: 'Не в списке' },
  ]

  return (
    <div className={styles.filtersSection}>
      <div className={styles.filtersLabel}>Фильтр по подрядчику</div>
      <div className={styles.companyFilter}>
        {options.map(o => (
          <button
            key={o.value}
            className={`${styles.filterChip} ${filterCompany === o.value ? styles.filterChipActive : ''}`}
            onClick={() => setFilterCompany(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
