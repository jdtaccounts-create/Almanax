<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  buildCraftPlan,
  CATEGORIES,
  checkAlmanaxDataStatus,
  defaultPeriod,
  displayDate,
  loadAlmanaxData,
  loadCachedEntries,
  refreshAlmanaxEntries,
  selectedApiDates,
  syncAlmanaxData,
  syncAlmanaxImages,
  type AlmanaxSyncProgressEvent,
  type AlmanaxData,
  type CraftLine,
  type DatabaseStatus,
  type CraftPlan,
  type ItemEntry,
} from './almanaxLogic'
import { allocateOwned, setCraftLineAllocation, type OwnedQuantities } from './possession'
import { compareItemIds } from './resourceSort'
import {
  acquireSharedSyncLock,
  clearCachedImages,
  heartbeatSharedSyncLock,
  loadCachedImagesForIds,
  readSharedSyncLock,
  releaseSharedSyncLock,
  saveFailedCachedImages,
  type SharedSyncLock,
} from './almanaxStorage'

type ThemeMode = 'dark' | 'light'
type CalendarDay = {
  key: string
  iso: string
  label: number
  muted: boolean
  inRange: boolean
  selected: boolean
  today: boolean
}
type AppUpdate = {
  currentVersion: string
  version: string
  date?: string
  body?: string
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>
}
type DownloadEvent = {
  event: 'Started' | 'Progress' | 'Finished'
  data?: {
    contentLength?: number
    chunkLength?: number
  }
}

const data = ref<AlmanaxData | null>(null)
const entries = ref<ItemEntry[]>([])
const loading = ref(true)
const working = ref(false)
const status = ref('Chargement des donnees locales...')
const dataStatusLabel = ref('Donnees locales')
const updateAvailable = ref(false)
const appUpdate = shallowRef<AppUpdate | null>(null)
const showAppUpdatePrompt = ref(false)
const checkingAppUpdate = ref(false)
const installingAppUpdate = ref(false)
const updateProgress = ref('')
const craftOpen = ref(false)
const craftPlan = ref<CraftPlan | null>(null)
const checkedEntries = ref<Set<string>>(new Set())
const checkedCraftLines = ref<Set<string>>(new Set())
const ownedQuantities = ref<OwnedQuantities>({})
const cachedImageUrls = ref<Map<number, string>>(new Map())
const themeMode = ref<ThemeMode>('dark')
const period = defaultPeriod()
const startDate = ref(period.start)
const endDate = ref(period.end)
const calendarMonth = ref(startOfMonth(parseIsoDate(period.start)))
let autoRefreshTimer: number | undefined
let overflowUpdateFrame: number | undefined
let wheelQuantityLockUntil = 0
const WHEEL_QUANTITY_LOCK_MS = 650
const quantityFormatter = new Intl.NumberFormat('fr-FR')
const byteFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const FORCE_FULL_SYNC_KEY = 'almanax-force-full-sync'
const FORCE_FULL_SYNC_PARAM = 'forceFullSync'
const EXTERNAL_SYNC_IDLE_CONFIRM_MS = 3500
const ESTIMATED_IMAGE_BYTES = 40 * 1024

type SyncTaskKey = 'items' | 'recipes' | 'itemSets' | 'images'

interface SyncTaskState {
  key: SyncTaskKey
  label: string
  done: number
  total: number
  bytesDone: number
  bytesTotal?: number
}

const syncTaskOrder: SyncTaskKey[] = ['items', 'recipes', 'itemSets', 'images']
const syncTaskLabels: Record<SyncTaskKey, string> = {
  items: 'Items',
  recipes: 'Recettes',
  itemSets: 'Panoplies',
  images: 'Images',
}

function createSyncTasks(): Record<SyncTaskKey, SyncTaskState> {
  return Object.fromEntries(syncTaskOrder.map((key) => [key, {
    key,
    label: syncTaskLabels[key],
    done: 0,
    total: 0,
    bytesDone: 0,
  }])) as Record<SyncTaskKey, SyncTaskState>
}

const syncVisible = ref(false)
const syncExternalWait = ref(false)
const syncPhase = ref('Vérification des données DofusDB...')
const syncStartedAt = ref(Date.now())
const syncUpdatedAt = ref(Date.now())
const syncMeasuredSpeed = ref(0)
const syncTasks = ref<Record<SyncTaskKey, SyncTaskState>>(createSyncTasks())
let syncSpeedSamples: Array<{ at: number; bytesDone: number }> = []
let syncHideTimer: number | undefined

const selectedDates = computed(() => selectedApiDates(startDate.value, endDate.value))
const syncRows = computed(() => {
  const rows = syncTaskOrder.map((key) => syncTasks.value[key])
  return syncVisible.value ? rows : rows.filter((task) => task.total > 0 || task.done > 0)
})
const syncTotals = computed(() => {
  const rows = syncRows.value
  const estimatedBytesTotal = rows.reduce((total, task) => total + estimatedTaskBytesTotal(task), 0)
  return {
    done: rows.reduce((total, task) => total + task.done, 0),
    total: rows.reduce((total, task) => total + task.total, 0),
    bytesDone: rows.reduce((total, task) => total + task.bytesDone, 0),
    estimatedBytesTotal,
  }
})
const syncPercent = computed(() => {
  const countPercent = syncTotals.value.total > 0
    ? Math.min(100, Math.round((syncTotals.value.done / syncTotals.value.total) * 100))
    : 0
  if (syncTotals.value.estimatedBytesTotal > 0) {
    const bytePercent = Math.min(100, Math.round((syncTotals.value.bytesDone / syncTotals.value.estimatedBytesTotal) * 100))
    return Math.max(bytePercent, countPercent)
  }
  return countPercent
})
const syncEta = computed(() => {
  syncUpdatedAt.value
  if (syncTotals.value.total > 0 && syncTotals.value.done >= syncTotals.value.total) return ''
  const speed = syncMeasuredSpeed.value
  const remainingBytes = Math.max(0, syncTotals.value.estimatedBytesTotal - syncTotals.value.bytesDone)
  if (speed > 0 && remainingBytes > 0) return formatDuration(remainingBytes / speed)
  const { done, total } = syncTotals.value
  if (!done || !total || done >= total) return ''
  const elapsedSeconds = Math.max(1, (Date.now() - syncStartedAt.value) / 1000)
  return formatDuration((elapsedSeconds / done) * (total - done))
})
const syncDownloadDetails = computed(() => {
  const bytesDone = syncTotals.value.bytesDone
  const estimatedTotal = syncTotals.value.estimatedBytesTotal
  const allProcessed = syncTotals.value.total > 0 && syncTotals.value.done >= syncTotals.value.total
  const remaining = Math.max(0, estimatedTotal - bytesDone)
  const totalText = estimatedTotal
    ? `${allProcessed || estimatedTotal <= bytesDone ? '' : '~'}${formatBytes(Math.max(estimatedTotal, bytesDone))}`
    : 'en estimation'
  return [
    { label: 'Total', value: totalText },
    { label: 'Restant', value: allProcessed ? '0 o' : (estimatedTotal ? `~${formatBytes(remaining)}` : 'en estimation') },
    { label: 'Vitesse', value: syncMeasuredSpeed.value > 0 ? `${formatBytes(syncMeasuredSpeed.value)}/s` : 'en estimation' },
    { label: 'Temps restant', value: syncEta.value ? `~${syncEta.value}` : (allProcessed ? '0 s' : 'en estimation') },
  ]
})

const groupedEntries = computed(() => {
  const groups = Object.fromEntries(CATEGORIES.map((category) => [category, [] as ItemEntry[]]))
  entries.value.forEach((entry) => groups[entry.category].push(entry))
  CATEGORIES.forEach((category) => groups[category].sort(compareEntries))
  return groups
})

const remainingEntries = computed(() => entries.value.filter((entry) => !entryDone(entry)))

const craftSections = computed(() => {
  const plan = craftPlan.value
  if (!plan) return []
  return [
    { key: 'direct_crafts', title: 'Base a craft', lines: sortLines(plan.direct_crafts) },
    { key: 'sub_crafts', title: 'Sous-crafts', lines: sortLines(plan.sub_crafts) },
    { key: 'ingredients', title: 'Ingredients', lines: sortLines(mergeLines([...plan.ingredients, ...plan.obtain_directly, ...plan.excluded])) },
  ]
})

const rawCraftLines = computed(() => {
  const plan = craftPlan.value
  if (!plan) return []
  return [
    ...plan.direct_crafts,
    ...plan.sub_crafts,
    ...mergeLines([...plan.ingredients, ...plan.obtain_directly, ...plan.excluded]),
  ]
})
const craftLines = computed(() => craftSections.value.flatMap((section) => section.lines))
const craftDoneCount = computed(() => craftLines.value.filter((line) => craftLineDone(line)).length)
const entryLines = computed(() => entries.value.map(entryToCraftLine))
const allocatableLines = computed(() => {
  if (!rawCraftLines.value.length) return entryLines.value
  const lines = [...rawCraftLines.value]
  entryLines.value.forEach((entryLine) => {
    if (!lines.some((line) => line.item_id === entryLine.item_id && lineCompletesEntry(line))) {
      lines.unshift(entryLine)
    }
  })
  return lines
})
const ownedAllocations = computed(() => allocateOwned(allocatableLines.value, ownedQuantities.value))

function addCoveredDependencies(covered: Map<number, number>, line: CraftLine, progress: number): void {
  const plan = craftPlan.value
  if (!plan || progress <= 0 || line.quantity <= 0) return
  Object.entries(plan.dependencies[line.line_key] || {}).forEach(([itemId, quantity]) => {
    const coveredQuantity = Math.round((Number(quantity) * progress) / line.quantity)
    if (!coveredQuantity) return
    covered.set(Number(itemId), (covered.get(Number(itemId)) || 0) + coveredQuantity)
  })
}

const coveredByItemId = computed(() => {
  const covered = new Map<number, number>()
  const plan = craftPlan.value
  if (!plan) return covered
  craftLines.value.forEach((line) => {
    if (!craftLineCanCoverDependencies(line)) return
    addCoveredDependencies(covered, line, ownedAllocations.value[line.line_key] || 0)
  })
  return covered
})

const calendarTitle = computed(() => {
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(calendarMonth.value)
  return `${month} ${calendarMonth.value.getFullYear()}`
})

const calendarDays = computed<CalendarDay[]>(() => {
  const first = startOfMonth(calendarMonth.value)
  const startOffset = (first.getDay() + 6) % 7
  const gridStart = addDays(first, -startOffset)
  const rangeStart = parseIsoDate(startDate.value)
  const rangeEnd = parseIsoDate(endDate.value)
  const today = isoDate(new Date())
  return Array.from({ length: 42 }, (_, index) => {
    const day = addDays(gridStart, index)
    const iso = isoDate(day)
    return {
      key: `${calendarMonth.value.getFullYear()}-${calendarMonth.value.getMonth()}-${index}`,
      iso,
      label: day.getDate(),
      muted: day.getMonth() !== calendarMonth.value.getMonth(),
      inRange: day >= rangeStart && day <= rangeEnd,
      selected: iso === startDate.value || iso === endDate.value,
      today: iso === today,
    }
  })
})

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isoDate(day: Date): string {
  const year = day.getFullYear()
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

function addDays(day: Date, count: number): Date {
  const next = new Date(day)
  next.setDate(next.getDate() + count)
  return next
}

function startOfMonth(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), 1)
}

function entryKey(entry: ItemEntry): string {
  return `${entry.date}:${entry.item_id}`
}

function lineKey(line: CraftLine): string {
  return line.line_key
}

function sortKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr')
}

function compareText(a: string, b: string): number {
  return sortKey(a).localeCompare(sortKey(b), 'fr')
}

function entryDone(entry: ItemEntry): boolean {
  return entryOwned(entry) >= entry.quantity
}

function lineCompletesEntry(line: CraftLine): boolean {
  return line.line_key.startsWith('direct_crafts:')
    || line.line_key.startsWith('obtain_directly:')
    || line.line_key.startsWith('excluded:')
    || line.line_key.startsWith('entry:')
}

function craftLineDone(line: CraftLine): boolean {
  return craftLineProgress(line) >= line.quantity
}

function compareEntries(a: ItemEntry, b: ItemEntry): number {
  return Number(entryDone(a)) - Number(entryDone(b))
    || (data.value ? compareItemIds(data.value, a.item_id, b.item_id) : 0)
    || a.order - b.order
    || compareText(a.raw_type, b.raw_type)
    || compareText(a.name, b.name)
    || a.item_id - b.item_id
}

function compareLines(a: CraftLine, b: CraftLine): number {
  return Number(craftLineDone(a)) - Number(craftLineDone(b))
    || (data.value ? compareItemIds(data.value, a.item_id, b.item_id) : 0)
    || compareText(a.raw_type, b.raw_type)
    || compareText(a.name, b.name)
    || a.item_id - b.item_id
}

function sortLines(lines: CraftLine[]): CraftLine[] {
  return [...lines].sort(compareLines)
}

function mergeLines(lines: CraftLine[]): CraftLine[] {
  const merged = new Map<number, CraftLine>()
  lines.forEach((line) => {
    const existing = merged.get(line.item_id)
    if (existing) existing.quantity += line.quantity
    else merged.set(line.item_id, { ...line, line_key: `ingredients:${line.item_id}` })
  })
  return Array.from(merged.values())
}

function categoryTitle(category: string): string {
  if (category === 'Equipement') return 'Equipements'
  return `${category}s`
}

function categoryProgress(category: string): string {
  const rows = groupedEntries.value[category] || []
  return `${formatQuantity(rows.filter(entryDone).length)}/${formatQuantity(rows.length)}`
}

function formatQuantity(value: number): string {
  return quantityFormatter.format(Math.max(0, Math.floor(Number(value) || 0)))
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${formatQuantity(bytes)} o`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${byteFormatter.format(kilobytes)} Ko`
  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${byteFormatter.format(megabytes)} Mo`
  return `${byteFormatter.format(megabytes / 1024)} Go`
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remainingSeconds = rounded % 60
  if (!minutes) return `${remainingSeconds} s`
  if (!remainingSeconds) return `${minutes} min`
  return `${minutes} min ${remainingSeconds} s`
}

function estimatedTaskBytesTotal(task: SyncTaskState): number {
  if (task.done > 0 && task.total > 0) {
    const averageEstimate = (task.bytesDone / task.done) * task.total
    return Math.max(task.bytesDone, task.bytesTotal || 0, averageEstimate)
  }
  return Math.max(task.bytesDone, task.bytesTotal || 0)
}

function quantityTotalWidth(category: string): string {
  const rows = groupedEntries.value[category] || []
  const chars = rows.reduce((maximum, entry) => Math.max(maximum, formatQuantity(entry.quantity).length), 1)
  return `${10 + chars * 8}px`
}

function quantityInputWidthForValues(values: number[]): string {
  const chars = values.reduce((maximum, value) => Math.max(maximum, String(Math.max(0, Math.floor(value))).length), 1)
  return `${Math.max(42, 14 + chars * 8)}px`
}

function quantityInputWidth(category: string): string {
  const rows = groupedEntries.value[category] || []
  return quantityInputWidthForValues(rows.map((entry) => entry.quantity))
}

function craftQuantityTotalWidth(lines: CraftLine[]): string {
  const chars = lines.reduce((maximum, line) => Math.max(maximum, formatQuantity(line.quantity).length), 1)
  return `${10 + chars * 8}px`
}

function craftQuantityInputWidth(lines: CraftLine[]): string {
  return quantityInputWidthForValues(lines.map((line) => line.quantity))
}

function shortDisplayDate(value: string): string {
  return displayDate(value).slice(0, 5)
}

function entrySourceLabel(entry: ItemEntry): string {
  return entry.raw_type
}

function todayEntryDate(): string {
  const today = new Date()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${month}/${day}/${today.getFullYear()}`
}

function isTodayEntry(entry: ItemEntry): boolean {
  return entry.date === todayEntryDate()
}

function setEntryChecked(entry: ItemEntry, checked: boolean): void {
  const next = new Set(checkedEntries.value)
  if (checked) next.add(entryKey(entry))
  else next.delete(entryKey(entry))
  checkedEntries.value = next
  changeEntryOwned(entry, checked ? entry.quantity : 0)

  if (!craftPlan.value) return
  const nextCraft = new Set(checkedCraftLines.value)
  craftLines.value
    .filter((line) => line.item_id === entry.item_id && lineCompletesEntry(line))
    .forEach((line) => {
      if (checked) nextCraft.add(lineKey(line))
      else nextCraft.delete(lineKey(line))
    })
  checkedCraftLines.value = nextCraft
  scheduleScrollableListUpdate()
}

function setCraftChecked(line: CraftLine, checked: boolean): void {
  const next = new Set(checkedCraftLines.value)
  if (checked && craftLineCanCoverDependencies(line)) next.add(lineKey(line))
  else next.delete(lineKey(line))
  checkedCraftLines.value = next

  const desiredOwned = checked ? line.quantity : 0
  ownedQuantities.value = setCraftLineAllocation(ownedQuantities.value, allocatableLines.value, line.line_key, desiredOwned)

  if (!lineCompletesEntry(line)) return
  const linkedEntries = entries.value.filter((entry) => entry.item_id === line.item_id)
  const nextEntries = new Set(checkedEntries.value)
  linkedEntries.forEach((entry) => {
    if (checked) nextEntries.add(entryKey(entry))
    else nextEntries.delete(entryKey(entry))
  })
  checkedEntries.value = nextEntries
  scheduleScrollableListUpdate()
}

function craftLineCanCoverDependencies(line: CraftLine): boolean {
  return line.line_key.startsWith('direct_crafts:') || line.line_key.startsWith('sub_crafts:')
}

function entryToCraftLine(entry: ItemEntry): CraftLine {
  return {
    line_key: `entry:${entryKey(entry)}`,
    item_id: entry.item_id,
    quantity: entry.quantity,
    name: entry.name,
    raw_type: entry.raw_type,
    category: entry.category,
    image_path: entry.image_path,
    meta: shortDisplayDate(entry.date),
  }
}

function allocationLineForEntry(entry: ItemEntry): CraftLine {
  return allocatableLines.value.find((line) => line.item_id === entry.item_id && lineCompletesEntry(line))
    || entryToCraftLine(entry)
}

function entryOwned(entry: ItemEntry): number {
  return Math.min(ownedAllocations.value[allocationLineForEntry(entry).line_key] || 0, entry.quantity)
}

function changeEntryOwned(entry: ItemEntry, quantity: number): void {
  const line = allocationLineForEntry(entry)
  ownedQuantities.value = setCraftLineAllocation(ownedQuantities.value, allocatableLines.value, line.line_key, quantity)
  const next = new Set(checkedEntries.value)
  if (quantity >= entry.quantity) next.add(entryKey(entry))
  else next.delete(entryKey(entry))
  checkedEntries.value = next
}

function craftLineOwned(line: CraftLine): number {
  return ownedAllocations.value[line.line_key] || 0
}

function craftLineCovered(line: CraftLine): number {
  return Math.min(coveredByItemId.value.get(line.item_id) || 0, line.quantity)
}

function craftLineProgress(line: CraftLine): number {
  if (checkedCraftLines.value.has(line.line_key)) return line.quantity
  return Math.min(line.quantity, craftLineOwned(line) + craftLineCovered(line))
}

function craftLineChecked(line: CraftLine): boolean {
  return craftLineProgress(line) >= line.quantity
}

function changeCraftOwned(line: CraftLine, quantity: number): void {
  const desiredProgress = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), line.quantity))
  const desiredOwned = Math.max(0, desiredProgress - craftLineCovered(line))
  const nextOwned = setCraftLineAllocation(ownedQuantities.value, allocatableLines.value, line.line_key, desiredOwned)
  const nextAllocation = allocateOwned(allocatableLines.value, nextOwned)[line.line_key] || 0
  const nextProgress = Math.min(line.quantity, nextAllocation + craftLineCovered(line))
  ownedQuantities.value = nextOwned
  const nextCraft = new Set(checkedCraftLines.value)
  if (craftLineCanCoverDependencies(line) && nextProgress >= line.quantity) {
    nextCraft.add(line.line_key)
  } else {
    nextCraft.delete(line.line_key)
  }
  checkedCraftLines.value = nextCraft

  if (!lineCompletesEntry(line)) return
  const linkedEntries = entries.value.filter((entry) => entry.item_id === line.item_id)
  const nextEntries = new Set(checkedEntries.value)
  linkedEntries.forEach((entry) => {
    if (nextProgress >= line.quantity) nextEntries.add(entryKey(entry))
    else nextEntries.delete(entryKey(entry))
  })
  checkedEntries.value = nextEntries
}

function handleOwnedInputWheel(event: WheelEvent): void {
  const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.owned-input[data-wheel-kind]')
  if (!input) return
  event.preventDefault()
  event.stopPropagation()
  if (Date.now() < wheelQuantityLockUntil) return
  const delta = event.deltaY < 0 ? 1 : -1
  if (input.dataset.wheelKind === 'entry') {
    const key = input.dataset.entryKey
    const entry = entries.value.find((candidate) => entryKey(candidate) === key)
    if (entry) {
      const wasDone = entryDone(entry)
      changeEntryOwned(entry, entryOwned(entry) + delta)
      if (wasDone !== entryDone(entry)) wheelQuantityLockUntil = Date.now() + WHEEL_QUANTITY_LOCK_MS
    }
    return
  }
  if (input.dataset.wheelKind === 'craft') {
    const lineKey = input.dataset.lineKey
    const line = craftLines.value.find((candidate) => candidate.line_key === lineKey)
    if (line) {
      const wasDone = craftLineChecked(line)
      changeCraftOwned(line, craftLineProgress(line) + delta)
      if (wasDone !== craftLineChecked(line)) wheelQuantityLockUntil = Date.now() + WHEEL_QUANTITY_LOCK_MS
    }
  }
}

function imageUrl(path: string, itemId?: number): string {
  if (itemId) {
    const cachedUrl = cachedImageUrls.value.get(itemId)
    if (cachedUrl) return cachedUrl
  }
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) return ''
  return `/${path.replace(/\\/g, '/')}`
}

function visibleImageIds(): number[] {
  const ids = [
    ...entries.value.map((entry) => entry.item_id),
    ...craftLines.value.map((line) => line.item_id),
  ]
  return ids.filter((id): id is number => Number.isFinite(id))
}

async function ensureCachedImageUrlsForIds(itemIds: Iterable<number>): Promise<void> {
  const source = data.value
  if (!source) return
  const ids = [...new Set([...itemIds].map((id) => Number(id)).filter(Number.isFinite))]
    .filter((itemId) => !cachedImageUrls.value.has(itemId))
    .filter((itemId) => {
      const item = source.items[String(itemId)]
      return item && !item.image_path && item.image_url
    })
  if (!ids.length) return
  const cached = await loadCachedImagesForIds(ids).catch(() => [])
  if (!cached.length) return
  const next = new Map(cachedImageUrls.value)
  cached.forEach(({ itemId, blob }) => {
    if (!next.has(itemId)) next.set(itemId, URL.createObjectURL(blob))
  })
  cachedImageUrls.value = next
}

async function ensureVisibleCachedImageUrls(): Promise<void> {
  await ensureCachedImageUrlsForIds(visibleImageIds())
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

async function openItem(itemId: number): Promise<void> {
  const url = `https://dofusdb.fr/database/object/${itemId}`
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
      return
    } catch {
      // Fallback navigateur pendant le dev.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function checkAppUpdate(showPrompt: boolean): Promise<void> {
  if (!isTauriRuntime() || checkingAppUpdate.value || installingAppUpdate.value) return
  checkingAppUpdate.value = true
  updateProgress.value = ''
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      appUpdate.value = update
      showAppUpdatePrompt.value = true
      status.value = `Mise a jour ${update.version} disponible`
      checkingAppUpdate.value = false
      await installAppUpdate()
      return
    }
    appUpdate.value = null
    showAppUpdatePrompt.value = false
    if (!showPrompt) status.value = 'Application deja a jour'
  } catch (error) {
    if (!showPrompt) status.value = `Verification maj impossible : ${String(error)}`
  } finally {
    checkingAppUpdate.value = false
  }
}

async function acquireAppUpdateLock(): Promise<() => void> {
  let heartbeatTimer: number | undefined
  while (true) {
    try {
      const lockStatus = await acquireSharedSyncLock('Almanax', 'app-update')
      if (lockStatus.acquired) {
        heartbeatTimer = window.setInterval(() => {
          void heartbeatSharedSyncLock('Almanax', 'app-update').catch(() => {})
        }, 1000)
        return () => {
          if (heartbeatTimer) window.clearInterval(heartbeatTimer)
          void releaseSharedSyncLock().catch(() => {})
        }
      }
      const owner = lockStatus.lock?.app || 'Une autre app'
      updateProgress.value = `${owner} termine une operation commune. Almanax attend son tour...`
      await sleep(1500)
    } catch {
      // If the shared lock is unavailable, keep the updater usable.
      return () => {}
    }
  }
}

async function installAppUpdate(): Promise<void> {
  if (installingAppUpdate.value) return
  if (!appUpdate.value) {
    await checkAppUpdate(false)
    if (!appUpdate.value) return
  }
  installingAppUpdate.value = true
  showAppUpdatePrompt.value = true
  updateProgress.value = 'Preparation de la mise a jour...'
  let downloaded = 0
  let total: number | undefined
  let releaseAppUpdateLock: (() => void) | null = null
  try {
    releaseAppUpdateLock = await acquireAppUpdateLock()
    updateProgress.value = 'Telechargement de la mise a jour...'
    await appUpdate.value.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        downloaded = 0
        total = event.data?.contentLength
        updateProgress.value = total ? `Telechargement : 0/${Math.round(total / 1024 / 1024)} Mo` : 'Telechargement...'
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength || 0
        updateProgress.value = total
          ? `Telechargement : ${Math.min(100, Math.round((downloaded / total) * 100))}%`
          : `Telechargement : ${Math.round(downloaded / 1024 / 1024)} Mo`
      } else {
        updateProgress.value = 'Installation terminee, redemarrage...'
      }
    })
    releaseAppUpdateLock()
    releaseAppUpdateLock = null
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    updateProgress.value = `Mise a jour impossible : ${String(error)}`
    status.value = updateProgress.value
  } finally {
    if (releaseAppUpdateLock) releaseAppUpdateLock()
    installingAppUpdate.value = false
  }
}

function loadCached(): void {
  if (!data.value) return
  entries.value = loadCachedEntries(data.value, selectedDates.value)
  void ensureVisibleCachedImageUrls()
  scheduleScrollableListUpdate()
}

function scheduleRefresh(): void {
  if (!data.value || loading.value) return
  if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer)
  autoRefreshTimer = window.setTimeout(() => {
    autoRefreshTimer = undefined
    if (working.value) {
      scheduleRefresh()
      return
    }
    void refresh()
  }, 180)
}

async function refresh(): Promise<void> {
  if (!data.value) return
  if (!selectedDates.value.length) {
    status.value = 'Erreur : la date de debut est apres la date de fin'
    return
  }
  working.value = true
  status.value = 'Synchronisation Almanax...'
  try {
    entries.value = await refreshAlmanaxEntries(data.value, selectedDates.value, (message) => { status.value = message })
    checkedEntries.value = new Set()
    checkedCraftLines.value = new Set()
    ownedQuantities.value = {}
    craftPlan.value = null
    craftOpen.value = false
    status.value = `${formatQuantity(entries.value.length)} offrandes chargees`
    await ensureVisibleCachedImageUrls()
    scheduleScrollableListUpdate()
  } catch (error) {
    loadCached()
    status.value = entries.value.length ? `Mode cache local : ${String(error)}` : `Erreur : ${String(error)}`
  } finally {
    working.value = false
  }
}

async function checkStatus(autoSync = false): Promise<void> {
  if (!data.value) return
  try {
    if (isForceFullSyncRequested()) {
      await syncData(true)
      return
    }
    const info = await checkAlmanaxDataStatus(data.value)
    updateAvailable.value = info.needsSync
    if (info.needsSync) {
      dataStatusLabel.value = 'Mise a jour disponible'
      status.value = `Donnees incompletes : ${info.missingLabels.join(', ')}`
      if (autoSync) {
        const dataLabels = info.missingLabels.filter((label) => label === 'items' || label === 'recettes' || label === 'panoplies')
        if (dataLabels.length) await syncData()
        else if (info.missingLabels.includes('images')) await syncImagesOnly()
      }
      return
    }
    dataStatusLabel.value = 'Donnees DofusDB a jour'
    status.value = `Donnees locales a jour : ${info.localItemTotal} items, ${info.localRecipeTotal} recettes`
  } catch {
    updateAvailable.value = false
    dataStatusLabel.value = 'Connexion indisponible'
    status.value = 'Connexion indisponible : donnees locales conservees'
  }
}

function isForceFullSyncRequested(): boolean {
  try {
    if (localStorage.getItem(FORCE_FULL_SYNC_KEY) === '1') return true
  } catch {
    // Fall back to the URL flag below.
  }
  return new URLSearchParams(window.location.search).get(FORCE_FULL_SYNC_PARAM) === '1'
}

function clearForceFullSyncRequest(): void {
  try {
    localStorage.removeItem(FORCE_FULL_SYNC_KEY)
  } catch {
    // Best effort only.
  }
  const url = new URL(window.location.href)
  if (url.searchParams.has(FORCE_FULL_SYNC_PARAM)) {
    url.searchParams.delete(FORCE_FULL_SYNC_PARAM)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
}

function resetSyncProgress(phase: string): void {
  if (syncHideTimer) {
    window.clearTimeout(syncHideTimer)
    syncHideTimer = undefined
  }
  syncTasks.value = createSyncTasks()
  syncStartedAt.value = Date.now()
  syncUpdatedAt.value = Date.now()
  syncMeasuredSpeed.value = 0
  syncExternalWait.value = false
  syncSpeedSamples = [{ at: syncStartedAt.value, bytesDone: 0 }]
  syncPhase.value = phase
  syncVisible.value = true
}

function completeSyncProgress(phase: string, hideDelay = 900): void {
  syncPhase.value = phase
  syncUpdatedAt.value = Date.now()
  if (syncHideTimer) window.clearTimeout(syncHideTimer)
  syncHideTimer = window.setTimeout(() => {
    syncVisible.value = false
    syncExternalWait.value = false
    syncHideTimer = undefined
  }, hideDelay)
}

function recordSyncSpeedSample(): void {
  const now = Date.now()
  const bytesDone = syncTotals.value.bytesDone
  syncSpeedSamples.push({ at: now, bytesDone })
  syncSpeedSamples = syncSpeedSamples.filter((sample) => now - sample.at <= 15_000)
  const first = syncSpeedSamples[0]
  const last = syncSpeedSamples[syncSpeedSamples.length - 1]
  if (!first || !last || last.at <= first.at || last.bytesDone <= first.bytesDone) {
    syncMeasuredSpeed.value = 0
    return
  }
  syncMeasuredSpeed.value = (last.bytesDone - first.bytesDone) / ((last.at - first.at) / 1000)
}

function updateSyncTask(key: SyncTaskKey, patch: Partial<Omit<SyncTaskState, 'key' | 'label'>>): void {
  syncTasks.value = {
    ...syncTasks.value,
    [key]: {
      ...syncTasks.value[key],
      ...patch,
    },
  }
  syncUpdatedAt.value = Date.now()
  recordSyncSpeedSample()
}

function seedSyncProgress(info: DatabaseStatus, needsDataSync: boolean): void {
  if (needsDataSync) {
    updateSyncTask('items', { done: 0, total: info.remoteItemTotal, bytesDone: 0 })
    updateSyncTask('recipes', { done: 0, total: info.remoteRecipeTotal, bytesDone: 0 })
    updateSyncTask('itemSets', { done: 0, total: info.remoteItemSetTotal, bytesDone: 0 })
  }
  const estimatedImageTotal = info.missingImageGroups || (needsDataSync ? info.remoteItemTotal : 0)
  if (estimatedImageTotal > 0) {
    updateSyncTask('images', {
      done: 0,
      total: estimatedImageTotal,
      bytesDone: 0,
      bytesTotal: estimatedImageTotal * ESTIMATED_IMAGE_BYTES,
    })
  }
}

function handleSyncProgress(event: AlmanaxSyncProgressEvent | string): void {
  if (typeof event === 'string') {
    syncPhase.value = event
    status.value = event
    syncUpdatedAt.value = Date.now()
    return
  }
  if (event.kind === 'message') {
    syncPhase.value = event.message
    status.value = event.message
    syncUpdatedAt.value = Date.now()
    return
  }
  if (event.kind === 'images') {
    updateSyncTask('images', {
      done: event.done,
      total: event.total,
      bytesDone: event.bytesDone,
      bytesTotal: event.bytesTotal,
    })
    status.value = `Images ${formatQuantity(event.done)} / ${formatQuantity(event.total)}`
    return
  }
  updateSyncTask(event.endpoint, {
    done: event.done,
    total: event.total,
    bytesDone: event.bytesDone,
  })
  status.value = `${event.label} ${formatQuantity(event.done)} / ${formatQuantity(event.total)}`
}

async function waitForSyncDialogPaint(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function externalSyncMessage(lock: SharedSyncLock): string {
  const phase = lock.phase ? ` (${lock.phase})` : ''
  return `${lock.app} met à jour la base Dofus commune${phase}...`
}

async function waitForExternalSharedSync(lock: SharedSyncLock): Promise<void> {
  resetSyncProgress(externalSyncMessage(lock))
  syncExternalWait.value = true
  status.value = externalSyncMessage(lock)
  await waitForSyncDialogPaint()
  let activeLock: SharedSyncLock | null = lock
  while (activeLock) {
    syncPhase.value = externalSyncMessage(activeLock)
    await sleep(2000)
    activeLock = await readSharedSyncLock().catch(() => null)
    if (!activeLock) {
      syncPhase.value = 'Synchronisation commune presque terminée...'
      await sleep(EXTERNAL_SYNC_IDLE_CONFIRM_MS)
      activeLock = await readSharedSyncLock().catch(() => null)
    }
  }
  syncPhase.value = 'Synchronisation commune terminée, vérification locale...'
  data.value = await loadAlmanaxData()
  await ensureVisibleCachedImageUrls().catch(() => {})
}

async function waitForStartupSharedSync(): Promise<boolean> {
  const lock = await readSharedSyncLock().catch(() => null)
  if (!lock) return false
  await waitForExternalSharedSync(lock)
  completeSyncProgress('Synchronisation commune terminée')
  return true
}

async function withSharedSyncLock<T>(phase: string, action: () => Promise<T>): Promise<T> {
  while (true) {
    const status = await acquireSharedSyncLock('Almanax', phase)
    if (status.acquired) {
      if (syncExternalWait.value) resetSyncProgress(phase)
      syncExternalWait.value = false
      syncPhase.value = phase
      break
    }
    if (status.lock) await waitForExternalSharedSync(status.lock)
    else await sleep(500)
  }
  const heartbeat = window.setInterval(() => {
    void heartbeatSharedSyncLock('Almanax', syncPhase.value || phase).catch(() => {})
  }, 5000)
  try {
    return await action()
  } finally {
    window.clearInterval(heartbeat)
    await releaseSharedSyncLock().catch(() => {})
  }
}

async function syncImagesOnly(): Promise<void> {
  if (!data.value) return
  const current = data.value
  working.value = true
  resetSyncProgress('Synchronisation des images utiles...')
  status.value = 'Synchronisation des images utiles...'
  try {
    await withSharedSyncLock('Synchronisation des images', async () => {
      await syncAlmanaxImages(current, handleSyncProgress)
      await ensureVisibleCachedImageUrls()
      updateAvailable.value = false
      dataStatusLabel.value = 'Donnees DofusDB a jour'
      await checkStatus()
      completeSyncProgress('Images synchronisées')
    })
  } catch (error) {
    console.error('[Almanax] image sync failed', error)
    status.value = `Erreur synchro images : ${String(error)}`
    completeSyncProgress('Synchronisation images impossible, données locales conservées', 1600)
  } finally {
    working.value = false
  }
}

async function syncData(forceFullSync = false): Promise<void> {
  working.value = true
  resetSyncProgress(forceFullSync ? 'Synchronisation complète forcée...' : 'Synchronisation des données...')
  status.value = forceFullSync ? 'Synchronisation complète forcée...' : 'Synchronisation des donnees...'
  try {
    await withSharedSyncLock(forceFullSync ? 'Synchronisation complète forcée' : 'Synchronisation des données', async () => {
    data.value = await loadAlmanaxData()
    if (!forceFullSync) {
      const info = await checkAlmanaxDataStatus(data.value)
      const dataLabels = info.missingLabels.filter((label) => label === 'items' || label === 'recettes' || label === 'panoplies')
      if (!dataLabels.length && !info.missingLabels.includes('images')) {
        updateAvailable.value = false
        dataStatusLabel.value = 'Donnees DofusDB a jour'
        status.value = 'Base Dofus commune déjà synchronisée'
        completeSyncProgress('Données déjà synchronisées')
        return
      }
      seedSyncProgress(info, dataLabels.length > 0)
      if (!dataLabels.length && info.missingLabels.includes('images')) {
        await syncAlmanaxImages(data.value, handleSyncProgress)
        await ensureVisibleCachedImageUrls()
        updateAvailable.value = false
        dataStatusLabel.value = 'Donnees DofusDB a jour'
        status.value = 'Images synchronisées'
        completeSyncProgress('Synchronisation terminée')
        return
      }
    }
    if (forceFullSync) {
      await clearCachedImages()
      await saveFailedCachedImages([])
      cachedImageUrls.value = new Map()
    }
    data.value = await syncAlmanaxData(handleSyncProgress)
    await syncAlmanaxImages(data.value, handleSyncProgress)
    updateAvailable.value = false
    dataStatusLabel.value = 'Donnees DofusDB a jour'
    loadCached()
    await refresh()
    if (forceFullSync) clearForceFullSyncRequest()
    await checkStatus()
    completeSyncProgress('Synchronisation terminée')
    })
  } catch (error) {
    status.value = `Erreur synchro : ${String(error)}`
    completeSyncProgress('Synchronisation impossible, données locales conservées', 1600)
  } finally {
    working.value = false
  }
}

function setToday(): void {
  const today = isoDate(new Date())
  startDate.value = today
  endDate.value = today
  calendarMonth.value = startOfMonth(parseIsoDate(today))
}

function resetCurrentMonth(): void {
  const next = defaultPeriod()
  startDate.value = next.start
  endDate.value = next.end
  calendarMonth.value = startOfMonth(parseIsoDate(next.start))
}

function shiftCalendarMonth(delta: number): void {
  const next = new Date(calendarMonth.value)
  next.setMonth(next.getMonth() + delta)
  calendarMonth.value = startOfMonth(next)
}

function selectCalendarDay(iso: string): void {
  const clicked = parseIsoDate(iso)
  const start = parseIsoDate(startDate.value)
  const end = parseIsoDate(endDate.value)
  if (clicked < start || startDate.value !== endDate.value) {
    startDate.value = iso
    endDate.value = iso
    return
  }
  endDate.value = iso
  if (clicked < end) endDate.value = iso
}

async function prepareCraftPlan(): Promise<void> {
  if (!data.value) return
  const base = remainingEntries.value
  if (!base.length) {
    status.value = 'Plan craft : aucune offrande restante'
    return
  }
  working.value = true
  try {
    const plan = buildCraftPlan(data.value, base)
    craftPlan.value = plan
    checkedCraftLines.value = new Set()
    craftOpen.value = true
    status.value = `Plan craft pret : ${formatQuantity(craftLines.value.length)} lignes`
    scheduleScrollableListUpdate()
  } catch {
    craftPlan.value = buildCraftPlan(data.value, base)
    checkedCraftLines.value = new Set()
    craftOpen.value = true
    status.value = `Plan craft pret : ${formatQuantity(craftLines.value.length)} lignes`
    scheduleScrollableListUpdate()
  } finally {
    working.value = false
  }
}

function applyTheme(mode: ThemeMode): void {
  themeMode.value = mode
  document.documentElement.dataset.theme = mode
  localStorage.setItem('almanax-theme', mode)
}

function toggleTheme(): void {
  applyTheme(themeMode.value === 'dark' ? 'light' : 'dark')
}

function updateScrollableListClasses(): void {
  document.querySelectorAll<HTMLElement>('.item-list, .craft-list').forEach((list) => {
    const hasScroll = list.scrollHeight > list.clientHeight + 1
    list.classList.toggle('has-scroll', hasScroll)
  })
}

function scheduleScrollableListUpdate(): void {
  if (overflowUpdateFrame) window.cancelAnimationFrame(overflowUpdateFrame)
  void nextTick(() => {
    overflowUpdateFrame = window.requestAnimationFrame(() => {
      overflowUpdateFrame = undefined
      updateScrollableListClasses()
    })
  })
}

watch([startDate, endDate], ([nextStart]) => {
  if (isIsoDate(nextStart)) calendarMonth.value = startOfMonth(parseIsoDate(nextStart))
  scheduleRefresh()
})

watch(
  [
    () => entries.value.length,
    () => craftLines.value.length,
    () => craftOpen.value,
  ],
  scheduleScrollableListUpdate,
  { flush: 'post' },
)

watch(
  () => visibleImageIds().join(','),
  () => {
    void ensureVisibleCachedImageUrls()
  },
  { flush: 'post' },
)

onMounted(async () => {
  window.addEventListener('wheel', handleOwnedInputWheel, { capture: true, passive: false })
  const savedTheme = localStorage.getItem('almanax-theme')
  applyTheme(savedTheme === 'light' ? 'light' : 'dark')
  try {
    const loadedFromSharedSync = await waitForStartupSharedSync()
    if (!loadedFromSharedSync || !data.value) {
      data.value = await loadAlmanaxData()
    }
    loadCached()
    loading.value = false
    status.value = entries.value.length ? `${formatQuantity(entries.value.length)} offrandes en cache` : 'Aucune offrande en cache'
    await refresh()
    await checkStatus(true)
    await checkAppUpdate(true)
    scheduleScrollableListUpdate()
  } catch (error) {
    loading.value = false
    dataStatusLabel.value = 'Erreur de chargement'
    status.value = `Erreur chargement : ${String(error)}`
    scheduleScrollableListUpdate()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('wheel', handleOwnedInputWheel, { capture: true })
})
</script>

<template>
  <main class="app-shell" :class="{ 'craft-active': craftOpen && craftPlan }">
    <section class="workspace">
      <aside class="period-panel glass-surface">
        <div class="period-quick-actions">
          <button type="button" :disabled="working" @click="setToday">Aujourd'hui</button>
          <button type="button" :disabled="working" @click="resetCurrentMonth">Mois en cours</button>
        </div>

        <div class="date-grid">
          <label class="date-field">
            <span>Debut</span>
            <span class="material-icons">calendar_month</span>
            <input v-model="startDate" type="date" :disabled="working" />
          </label>
          <label class="date-field">
            <span>Fin</span>
            <span class="material-icons">calendar_month</span>
            <input v-model="endDate" type="date" :disabled="working" />
          </label>
        </div>

        <div class="mini-calendar">
          <div class="calendar-head">
            <button class="calendar-nav" type="button" title="Mois precedent" @click="shiftCalendarMonth(-1)">
              <span class="material-icons">chevron_left</span>
            </button>
            <strong>{{ calendarTitle }}</strong>
            <button class="calendar-nav" type="button" title="Mois suivant" @click="shiftCalendarMonth(1)">
              <span class="material-icons">chevron_right</span>
            </button>
          </div>
          <div class="calendar-weekdays">
            <span>Lun</span><span>Mar</span><span>Mer</span><span>Jeu</span><span>Ven</span><span>Sam</span><span>Dim</span>
          </div>
          <div class="calendar-grid">
            <button
              v-for="day in calendarDays"
              :key="day.key"
              type="button"
              :class="{ muted: day.muted, range: day.inRange, selected: day.selected, today: day.today }"
              @click="selectCalendarDay(day.iso)"
            >
              {{ day.label }}
            </button>
          </div>
        </div>

        <footer class="period-footer">
          <button class="icon-action theme-dock" type="button" :title="themeMode === 'dark' ? 'Mode jour' : 'Mode nuit'" @click="toggleTheme">
            <span class="material-icons">{{ themeMode === 'dark' ? 'light_mode' : 'dark_mode' }}</span>
          </button>
        </footer>
      </aside>

      <section class="board-area">
        <div class="offering-columns" :aria-hidden="craftOpen && !!craftPlan">
          <article
            v-for="category in CATEGORIES"
            :key="category"
            class="offering-column glass-surface"
            :style="{ '--quantity-total-width': quantityTotalWidth(category), '--owned-input-width': quantityInputWidth(category) }"
          >
            <header>
              <h2>{{ categoryTitle(category) }}</h2>
              <span>{{ categoryProgress(category) }}</span>
            </header>
            <div v-if="groupedEntries[category]?.length" class="item-list has-items">
              <div
                v-for="entry in groupedEntries[category]"
                :key="entryKey(entry)"
                class="item-line"
                :class="{ done: entryDone(entry), today: isTodayEntry(entry) }"
              >
                <input type="checkbox" :checked="entryDone(entry)" @change="setEntryChecked(entry, ($event.target as HTMLInputElement).checked)" />
                <div class="quantity-control">
                  <input
                    class="owned-input"
                    type="number"
                    min="0"
                    :max="entry.quantity"
                    :value="entryOwned(entry)"
                    data-wheel-kind="entry"
                    :data-entry-key="entryKey(entry)"
                    aria-label="Quantité possédée"
                    @change="changeEntryOwned(entry, Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="quantity-total">/ {{ formatQuantity(entry.quantity) }}</span>
                </div>
                <div class="item-card">
                  <button class="item-link" type="button" @click="openItem(entry.item_id)">
                    <img v-if="imageUrl(entry.image_path, entry.item_id)" :src="imageUrl(entry.image_path, entry.item_id)" alt="" />
                    <span class="item-copy">
                      <strong>{{ entry.name }}</strong>
                      <small>{{ shortDisplayDate(entry.date) }} · {{ entrySourceLabel(entry) }}</small>
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="empty-state">Aucun item</div>
          </article>
        </div>

        <aside class="craft-drawer" :class="{ open: craftOpen && craftPlan }">
          <button v-if="!craftOpen || !craftPlan" class="craft-rail" type="button" @click="prepareCraftPlan">
            <span>PLAN<br />CRAFT</span>
          </button>

          <template v-else>
            <header class="craft-title">
              <button class="panel-close" type="button" title="Fermer" @click="craftOpen = false">
                <span class="material-icons">close</span>
              </button>
              <h2>Plan de craft</h2>
              <span>{{ formatQuantity(craftDoneCount) }}/{{ formatQuantity(craftLines.length) }}</span>
            </header>
            <div class="craft-columns">
              <article
                v-for="section in craftSections"
                :key="section.key"
                class="craft-column"
                :style="{ '--quantity-total-width': craftQuantityTotalWidth(section.lines), '--owned-input-width': craftQuantityInputWidth(section.lines) }"
              >
                <header>
                  <h3>{{ section.title }}</h3>
                  <span>{{ formatQuantity(section.lines.filter(craftLineDone).length) }}/{{ formatQuantity(section.lines.length) }}</span>
                </header>
                <div v-if="section.lines.length" class="item-list craft-list has-items">
                  <div
                    v-for="line in section.lines"
                    :key="line.line_key"
                    class="item-line"
                    :class="{ done: craftLineDone(line) }"
                    :data-progress="craftLineProgress(line)"
                    :data-quantity="line.quantity"
                  >
                    <input type="checkbox" :checked="craftLineChecked(line)" @change="setCraftChecked(line, ($event.target as HTMLInputElement).checked)" />
                    <div class="quantity-control">
                      <input
                        class="owned-input"
                        type="number"
                        min="0"
                        :max="line.quantity"
                        :value="craftLineProgress(line)"
                        data-wheel-kind="craft"
                        :data-line-key="line.line_key"
                        aria-label="Quantité validée"
                        @change="changeCraftOwned(line, Number(($event.target as HTMLInputElement).value))"
                      />
                      <span class="quantity-total">/ {{ formatQuantity(line.quantity) }}</span>
                    </div>
                    <div class="item-card">
                      <button class="item-link" type="button" @click="openItem(line.item_id)">
                        <img v-if="imageUrl(line.image_path, line.item_id)" :src="imageUrl(line.image_path, line.item_id)" alt="" />
                        <span class="item-copy">
                          <strong>{{ line.name }}</strong>
                          <small>{{ line.raw_type }}</small>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="empty-state compact">Aucun item</div>
              </article>
            </div>
          </template>
        </aside>
      </section>
    </section>

    <div v-if="syncVisible" class="sync-dialog catalog-sync-dialog">
      <section class="sync-card sync-progress-card glass-surface" role="status" aria-live="polite">
        <header class="sync-progress-head">
          <div>
            <span>Synchronisation des données DofusDB</span>
            <h2>{{ syncPhase }}</h2>
          </div>
          <strong v-if="!syncExternalWait">{{ syncPercent }}%</strong>
        </header>
        <template v-if="!syncExternalWait">
          <div class="sync-progress-track">
            <span :style="{ width: `${syncPercent}%` }"></span>
          </div>
          <div class="sync-progress-rows">
            <div v-for="task in syncRows" :key="task.key" class="sync-progress-row">
              <span>{{ task.label }}</span>
              <strong>{{ formatQuantity(task.done) }} / {{ formatQuantity(task.total) }}</strong>
            </div>
          </div>
          <div class="sync-progress-details" aria-label="Détails du téléchargement">
            <span v-for="detail in syncDownloadDetails" :key="detail.label">
              {{ detail.label }} :
              <strong>{{ detail.value }}</strong>
            </span>
          </div>
        </template>
        <p v-else>Cette app attend que la synchronisation commune se termine.</p>
      </section>
    </div>

    <div v-if="showAppUpdatePrompt && appUpdate" class="sync-dialog">
      <section class="sync-card glass-surface" role="dialog" aria-modal="true" aria-labelledby="app-update-title">
        <h2 id="app-update-title">Mise à jour nécessaire</h2>
        <p>
          La version {{ appUpdate.version }} est disponible. Almanax l'installe maintenant,
          puis redémarre automatiquement.
        </p>
        <p v-if="updateProgress" class="update-progress">{{ updateProgress }}</p>
      </section>
    </div>
  </main>
</template>
