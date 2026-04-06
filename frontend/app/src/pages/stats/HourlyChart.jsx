import { getHourlyForShift } from '../../utils/statsCalc.js'
import styles from './StatsPage.module.css'

export default function HourlyChart({ hourly, shiftFilter }) {
  const ordered = getHourlyForShift(hourly || [], shiftFilter)
  const hasData = ordered.some(h => h.ops > 0 || h.storageOps > 0 || h.kdkOps > 0)

  if (!hasData) {
    return <div className={styles.emptyRow}>Нет данных</div>
  }

  const maxBar = Math.max(...ordered.map(h => Math.max(h.storageOps, h.kdkOps)), 1)

  return (
    <>
      <div className={styles.hourlyBars}>
        {ordered.map(h => {
          const storageH = Math.max(Math.round((h.storageOps / maxBar) * 100), h.storageOps > 0 ? 3 : 0)
          const kdkH     = Math.max(Math.round((h.kdkOps    / maxBar) * 100), h.kdkOps    > 0 ? 3 : 0)
          return (
            <div key={h.hour} className={styles.hourlyCol}>
              {/* Значения над столбиками */}
              <div className={styles.hourlyValues}>
                {h.ops > 0 && (
                  <>
                    <span className={styles.hourlyOps}>{h.ops.toLocaleString('ru-RU')} оп.</span>
                    <span className={styles.hourlyEmployees}>{h.employees} чел.</span>
                  </>
                )}
              </div>

              {/* Столбики */}
              <div className={styles.hourlyBarWrap}>
                <div
                  className={styles.hourlyBarStorage}
                  style={{ height: `${storageH}%` }}
                  title={`Хранение: ${h.storageOps.toLocaleString('ru-RU')} оп., ${h.storageEmployees} чел.`}
                />
                <div
                  className={styles.hourlyBarKdk}
                  style={{ height: `${kdkH}%` }}
                  title={`КДК: ${h.kdkOps.toLocaleString('ru-RU')} оп., ${h.kdkEmployees} чел.`}
                />
              </div>

              {/* Метка часа */}
              <div className={styles.hourlyFooter}>
                <span className={styles.hourlyLabel}>{String(h.hour).padStart(2, '0')}:00</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Легенда */}
      <div className={styles.hourlyLegend}>
        <div className={styles.hourlyLegendItem}>
          <span className={styles.hourlyLegendDot} style={{ background: 'var(--green)' }} />
          Хранение
        </div>
        <div className={styles.hourlyLegendItem}>
          <span className={styles.hourlyLegendDot} style={{ background: 'var(--green-mid)' }} />
          КДК
        </div>
      </div>
    </>
  )
}
