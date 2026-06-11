export function normalizeFio(fio) {
  return (fio || '').trim().replace(/^-\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function personKey(norm) {
  const parts = (norm || '').split(/\s+/).filter(Boolean)
  if (parts.length === 0) return norm
  const initial = parts.length > 1 ? parts[1].charAt(0).toLowerCase() : ''
  return (parts[0] + ' ' + initial).trim()
}

function fioMatch(normA, normB) {
  if (normA === normB) return true
  const a = normA.split(/\s+/).filter(Boolean)
  const b = normB.split(/\s+/).filter(Boolean)
  if (!a[0] || a[0] !== b[0]) return false   // фамилии должны совпадать точно
  const fnA = a[1] || '', fnB = b[1] || ''
  if (fnA === fnB) return true                // имена совпадают точно
  // Инициальное сравнение только когда одна сторона — одна буква
  if (fnA.length === 1 && fnB.startsWith(fnA)) return true
  if (fnB.length === 1 && fnA.startsWith(fnB)) return true
  return false
}

export function hasMatchInEmplKeys(dataNorm, emplMap) {
  if (!dataNorm || !emplMap) return false
  if (emplMap.has(dataNorm)) return true
  for (const k of emplMap.keys()) {
    if (fioMatch(dataNorm, k)) return true
  }
  return false
}

export function getCompanyByFio(emplMap, dataNorm) {
  if (!emplMap || !dataNorm) return undefined
  const exact = emplMap.get(dataNorm)
  if (exact !== undefined) return exact
  for (const [k, v] of emplMap) {
    if (fioMatch(dataNorm, k)) return v
  }
  return undefined
}

export function getCompanyByEmployee(emplMap, emplIdMap, norm, executorId) {
  if (emplIdMap && executorId) {
    const byId = emplIdMap.get(executorId)
    if (byId !== undefined) return byId
  }
  return getCompanyByFio(emplMap, norm)
}

export function parseEmplCsv(csv) {
  const map = new Map()
  const companies = new Set()
  if (!csv) return { map, companies: [] }

  const lines = csv.split('\n')
  const firstLine = lines[0] || ''
  const sep = firstLine.includes(';') ? ';' : ','
  const firstCol = firstLine.split(sep)[0].trim().toLowerCase().replace(/^"|"$/g, '')
  const looksLikeHeader = ['фио', 'имя', 'name', 'сотрудник', 'ф.и.о', 'fio'].includes(firstCol)
  const startRow = looksLikeHeader ? 1 : 0

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = line.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))
    const fio = cols[0] || ''
    const company = cols[1] || ''
    if (fio) {
      map.set(normalizeFio(fio), company)
      if (company) companies.add(company)
    }
  }
  return { map, companies: [...companies].sort() }
}

export function flattenItem(item) {
  return {
    id: item.id || '',
    type: item.type || '',
    operationType: item.operationType || '',
    productName: item.product?.name || '',
    nomenclatureCode: item.product?.nomenclatureCode || '',
    barcodes: (item.product?.barcodes || []).join(', '),
    productionDate: item.part?.productionDate || '',
    bestBeforeDate: item.part?.bestBeforeDate || '',
    sourceBarcode: item.sourceAddress?.handlingUnitBarcode || '',
    cell: item.targetAddress?.cellAddress || item.sourceAddress?.cellAddress || '',
    targetBarcode: item.targetAddress?.handlingUnitBarcode || '',
    startedAt: item.operationStartedAt || '',
    completedAt: item.operationCompletedAt || '',
    executor: item.responsibleUser
      ? [item.responsibleUser.lastName, item.responsibleUser.firstName, item.responsibleUser.middleName]
          .filter(Boolean).join(' ').trim()
      : '',
    executorId: item.responsibleUser?.id || '',
    srcOld: item.sourceQuantity?.oldQuantity ?? '',
    srcNew: item.sourceQuantity?.newQuantity ?? '',
    tgtOld: item.targetQuantity?.oldQuantity ?? '',
    tgtNew: item.targetQuantity?.newQuantity ?? '',
    quantity: item.targetQuantity?.newQuantity ?? item.sourceQuantity?.oldQuantity ?? '',
  }
}
