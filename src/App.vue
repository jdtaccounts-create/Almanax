<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import {
  buildCraftPlan,
  CATEGORIES,
  checkAlmanaxDataStatus,
  defaultPeriod,
  displayDate,
  loadAlmanaxData,
  loadCachedEntries,
  refreshAlmanaxEntries,
  refreshItemDetails,
  saveStoredAlmanaxData,
  selectedApiDates,
  syncAlmanaxData,
  type AlmanaxData,
  type CraftLine,
  type CraftPlan,
  type ItemEntry,
} from './almanaxLogic'

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
const showSyncConfirm = ref(false)
const appUpdate = shallowRef<AppUpdate | null>(null)
const showAppUpdatePrompt = ref(false)
const checkingAppUpdate = ref(false)
const installingAppUpdate = ref(false)
const updateProgress = ref('')
const craftOpen = ref(false)
const craftPlan = ref<CraftPlan | null>(null)
const checkedEntries = ref<Set<string>>(new Set())
const checkedCraftLines = ref<Set<string>>(new Set())
const themeMode = ref<ThemeMode>('dark')
const period = defaultPeriod()
const startDate = ref(period.start)
const endDate = ref(period.end)
const calendarMonth = ref(startOfMonth(parseIsoDate(period.start)))

const itemCount = computed(() => Object.keys(data.value?.items || {}).length)
const recipeCount = computed(() => Object.keys(data.value?.recipes || {}).length)
const selectedDates = computed(() => selectedApiDates(startDate.value, endDate.value))

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

const craftLines = computed(() => craftSections.value.flatMap((section) => section.lines))
const craftDoneCount = computed(() => craftLines.value.filter((line) => craftLineDone(line)).length)
const appUpdateButtonVisible = computed(() => !!appUpdate.value || checkingAppUpdate.value || installingAppUpdate.value)
const appUpdateButtonLabel = computed(() => {
  if (installingAppUpdate.value) return 'Installation...'
  if (checkingAppUpdate.value) return 'Recherche...'
  return 'Mettre a jour'
})

const coveredByItemId = computed(() => {
  const covered = new Map<number, number>()
  const plan = craftPlan.value
  if (!plan) return covered
  checkedCraftLines.value.forEach((key) => {
    Object.entries(plan.dependencies[key] || {}).forEach(([itemId, quantity]) => {
      covered.set(Number(itemId), (covered.get(Number(itemId)) || 0) + Number(quantity))
    })
  })
  return covered
})

const headerSummary = computed(() => {
  if (loading.value) return status.value
  if (entries.value.length) return `${entries.value.length} offrandes chargees · ${dataStatusLabel.value}`
  return `${itemCount.value} items locaux · ${recipeCount.value} recettes locales · ${dataStatusLabel.value}`
})

const statusDotClass = computed(() => ({
  loading: loading.value || working.value,
  warn: updateAvailable.value,
  ok: !loading.value && !working.value && !updateAvailable.value,
}))

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
  return checkedEntries.value.has(entryKey(entry)) || (coveredByItemId.value.get(entry.item_id) || 0) >= entry.quantity
}

function lineCompletesEntry(line: CraftLine): boolean {
  return line.line_key.startsWith('direct_crafts:') || line.line_key.startsWith('obtain_directly:') || line.line_key.startsWith('excluded:')
}

function craftLineDone(line: CraftLine): boolean {
  if (checkedCraftLines.value.has(lineKey(line))) return true
  if ((coveredByItemId.value.get(line.item_id) || 0) >= line.quantity) return true
  if (!lineCompletesEntry(line)) return false
  return entries.value.some((entry) => entry.item_id === line.item_id && checkedEntries.value.has(entryKey(entry)))
}

function compareEntries(a: ItemEntry, b: ItemEntry): number {
  return Number(entryDone(a)) - Number(entryDone(b))
    || compareText(a.raw_type, b.raw_type)
    || compareText(a.name, b.name)
    || a.order - b.order
}

function compareLines(a: CraftLine, b: CraftLine): number {
  return Number(craftLineDone(a)) - Number(craftLineDone(b))
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
  return `${rows.filter(entryDone).length}/${rows.length}`
}

function shortDisplayDate(value: string): string {
  return displayDate(value).slice(0, 5)
}

function setEntryChecked(entry: ItemEntry, checked: boolean): void {
  const next = new Set(checkedEntries.value)
  if (checked) next.add(entryKey(entry))
  else next.delete(entryKey(entry))
  checkedEntries.value = next

  if (!craftPlan.value) return
  const nextCraft = new Set(checkedCraftLines.value)
  craftLines.value
    .filter((line) => line.item_id === entry.item_id && lineCompletesEntry(line))
    .forEach((line) => {
      if (checked) nextCraft.add(lineKey(line))
      else nextCraft.delete(lineKey(line))
    })
  checkedCraftLines.value = nextCraft
}

function setCraftChecked(line: CraftLine, checked: boolean): void {
  const next = new Set(checkedCraftLines.value)
  if (checked) next.add(lineKey(line))
  else next.delete(lineKey(line))
  checkedCraftLines.value = next

  if (!lineCompletesEntry(line)) return
  const linkedEntries = entries.value.filter((entry) => entry.item_id === line.item_id)
  linkedEntries.forEach((entry) => {
    const nextEntries = new Set(checkedEntries.value)
    if (checked) nextEntries.add(entryKey(entry))
    else nextEntries.delete(entryKey(entry))
    checkedEntries.value = nextEntries
  })
}

function progressLabel(line: CraftLine): string {
  const covered = Math.min(coveredByItemId.value.get(line.item_id) || 0, line.quantity)
  return covered > 0 && covered < line.quantity ? `${covered}/${line.quantity} x` : `${line.quantity} x`
}

function imageUrl(path: string): string {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `/${path.replace(/\\/g, '/')}`
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
      showAppUpdatePrompt.value = showPrompt
      status.value = `Mise a jour ${update.version} disponible`
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

function declineAppUpdate(): void {
  showAppUpdatePrompt.value = false
  updateProgress.value = 'Mise a jour disponible quand tu veux'
}

async function installAppUpdate(): Promise<void> {
  if (installingAppUpdate.value) return
  if (!appUpdate.value) {
    await checkAppUpdate(false)
    if (!appUpdate.value) return
  }
  installingAppUpdate.value = true
  showAppUpdatePrompt.value = true
  updateProgress.value = 'Telechargement de la mise a jour...'
  let downloaded = 0
  let total: number | undefined
  try {
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
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    updateProgress.value = `Mise a jour impossible : ${String(error)}`
    status.value = updateProgress.value
  } finally {
    installingAppUpdate.value = false
  }
}

function loadCached(): void {
  if (!data.value) return
  entries.value = loadCachedEntries(data.value, selectedDates.value)
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
    craftPlan.value = null
    craftOpen.value = false
    status.value = `${entries.value.length} offrandes chargees`
  } catch (error) {
    loadCached()
    status.value = entries.value.length ? `Mode cache local : ${String(error)}` : `Erreur : ${String(error)}`
  } finally {
    working.value = false
  }
}

async function checkStatus(): Promise<void> {
  if (!data.value) return
  try {
    const info = await checkAlmanaxDataStatus(data.value)
    updateAvailable.value = info.needsSync
    if (info.needsSync) {
      dataStatusLabel.value = 'Mise a jour disponible'
      status.value = `Donnees incompletes : ${info.missingLabels.join(', ')}`
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

async function requestSyncData(): Promise<void> {
  if (!data.value) {
    await syncData()
    return
  }
  working.value = true
  status.value = 'Verification DofusDB...'
  try {
    const info = await checkAlmanaxDataStatus(data.value)
    updateAvailable.value = info.needsSync
    if (info.needsSync) {
      working.value = false
      await syncData()
      return
    }
    dataStatusLabel.value = 'Donnees DofusDB a jour'
    status.value = 'Donnees deja a jour'
    showSyncConfirm.value = true
  } catch {
    dataStatusLabel.value = 'Connexion indisponible'
    status.value = 'Verification impossible : confirme si tu veux forcer la synchronisation'
    showSyncConfirm.value = true
  } finally {
    working.value = false
  }
}

async function syncData(): Promise<void> {
  showSyncConfirm.value = false
  working.value = true
  status.value = 'Synchronisation des donnees...'
  try {
    data.value = await syncAlmanaxData((message) => { status.value = message })
    updateAvailable.value = false
    dataStatusLabel.value = 'Donnees DofusDB a jour'
    loadCached()
    await refresh()
    await checkStatus()
  } catch (error) {
    status.value = `Erreur synchro : ${String(error)}`
  } finally {
    working.value = false
  }
}

function setToday(): void {
  const today = isoDate(new Date())
  startDate.value = today
  endDate.value = today
  calendarMonth.value = startOfMonth(parseIsoDate(today))
  status.value = 'Periode reglee sur aujourd hui'
}

function resetCurrentMonth(): void {
  const next = defaultPeriod()
  startDate.value = next.start
  endDate.value = next.end
  calendarMonth.value = startOfMonth(parseIsoDate(next.start))
  status.value = 'Periode remise au mois en cours'
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

async function toggleCraftPlan(): Promise<void> {
  if (craftOpen.value && craftPlan.value) {
    craftOpen.value = false
    return
  }
  await prepareCraftPlan()
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
    let plan = buildCraftPlan(data.value, base)
    const lineIds = [
      ...plan.direct_crafts,
      ...plan.sub_crafts,
      ...plan.ingredients,
      ...plan.obtain_directly,
      ...plan.excluded,
    ].map((line) => line.item_id)
    await refreshItemDetails(data.value, lineIds, (message) => { status.value = message })
    await saveStoredAlmanaxData(data.value)
    plan = buildCraftPlan(data.value, base)
    craftPlan.value = plan
    checkedCraftLines.value = new Set()
    craftOpen.value = true
    status.value = `Plan craft pret : ${craftLines.value.length} lignes`
  } catch {
    craftPlan.value = buildCraftPlan(data.value, base)
    checkedCraftLines.value = new Set()
    craftOpen.value = true
    status.value = `Plan craft pret : ${craftLines.value.length} lignes`
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

onMounted(async () => {
  const savedTheme = localStorage.getItem('almanax-theme')
  applyTheme(savedTheme === 'light' ? 'light' : 'dark')
  try {
    data.value = await loadAlmanaxData()
    loadCached()
    loading.value = false
    status.value = entries.value.length ? `${entries.value.length} offrandes en cache` : 'Aucune offrande en cache'
    await refresh()
    await checkStatus()
    await checkAppUpdate(true)
  } catch (error) {
    loading.value = false
    dataStatusLabel.value = 'Erreur de chargement'
    status.value = `Erreur chargement : ${String(error)}`
  }
})
</script>

<template>
  <main class="app-shell" :class="{ 'craft-active': craftOpen && craftPlan }">
    <header class="app-header glass-surface">
      <div class="brand-block">
        <h1>Almanax</h1>
        <p><span class="status-dot" :class="statusDotClass"></span>{{ headerSummary }}</p>
      </div>
      <div class="header-actions">
        <button class="q-action" type="button" :disabled="working" @click="refresh">
          <span class="material-icons">refresh</span>
          <span>Rafraichir</span>
        </button>
        <button class="q-action" type="button" :class="{ pulse: updateAvailable }" :disabled="working" @click="requestSyncData">
          <span class="material-icons">sync</span>
          <span>{{ updateAvailable ? 'Sync DofusDB !' : 'Sync DofusDB' }}</span>
        </button>
        <button class="q-action craft-button" type="button" :disabled="working" @click="toggleCraftPlan">
          <span class="material-icons">handyman</span>
          <span>Plan craft</span>
        </button>
        <button
          v-if="appUpdateButtonVisible"
          class="q-action update-button"
          type="button"
          :disabled="installingAppUpdate || checkingAppUpdate"
          @click="installAppUpdate"
        >
          <span class="material-icons">system_update_alt</span>
          <span>{{ appUpdateButtonLabel }}</span>
        </button>
        <button class="icon-action" type="button" :title="themeMode === 'dark' ? 'Mode jour' : 'Mode nuit'" @click="toggleTheme">
          <span class="material-icons">{{ themeMode === 'dark' ? 'light_mode' : 'dark_mode' }}</span>
        </button>
      </div>
    </header>

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

      </aside>

      <section class="board-area">
        <div class="offering-columns" :aria-hidden="craftOpen && !!craftPlan">
          <article v-for="category in CATEGORIES" :key="category" class="offering-column glass-surface">
            <header>
              <h2>{{ categoryTitle(category) }}</h2>
              <span>{{ categoryProgress(category) }}</span>
            </header>
            <div v-if="groupedEntries[category]?.length" class="item-list has-items">
              <div
                v-for="entry in groupedEntries[category]"
                :key="entryKey(entry)"
                class="item-line"
                :class="{ done: entryDone(entry) }"
              >
                <input type="checkbox" :checked="entryDone(entry)" @change="setEntryChecked(entry, ($event.target as HTMLInputElement).checked)" />
                <button class="item-card" type="button" @click="openItem(entry.item_id)">
                  <img v-if="imageUrl(entry.image_path)" :src="imageUrl(entry.image_path)" alt="" />
                  <span class="item-copy">
                    <strong>{{ entry.quantity }} x {{ entry.name }}</strong>
                    <small>{{ shortDisplayDate(entry.date) }} · {{ entry.raw_type }}</small>
                  </span>
                </button>
              </div>
            </div>
            <div v-else class="empty-state">Aucun item</div>
          </article>
        </div>

        <aside class="craft-drawer" :class="{ open: craftOpen && craftPlan }">
          <button v-if="!craftOpen || !craftPlan" class="craft-rail" type="button" @click="prepareCraftPlan">
            <span>PLAN CRAFT</span>
          </button>

          <template v-else>
            <header class="craft-title">
              <h2>Plan de craft</h2>
              <span>{{ craftDoneCount }}/{{ craftLines.length }}</span>
            </header>
            <div class="craft-columns">
              <article v-for="section in craftSections" :key="section.key" class="craft-column">
                <header>
                  <h3>{{ section.title }}</h3>
                  <span>{{ section.lines.filter(craftLineDone).length }}/{{ section.lines.length }}</span>
                </header>
                <div v-if="section.lines.length" class="item-list craft-list has-items">
                  <div v-for="line in section.lines" :key="line.line_key" class="item-line" :class="{ done: craftLineDone(line) }">
                    <input type="checkbox" :checked="craftLineDone(line)" @change="setCraftChecked(line, ($event.target as HTMLInputElement).checked)" />
                    <button class="item-card" type="button" @click="openItem(line.item_id)">
                      <img v-if="imageUrl(line.image_path)" :src="imageUrl(line.image_path)" alt="" />
                      <span class="item-copy">
                        <strong>{{ progressLabel(line) }} {{ line.name }}</strong>
                        <small>{{ line.raw_type }}</small>
                      </span>
                    </button>
                  </div>
                </div>
                <div v-else class="empty-state compact">Aucun item</div>
              </article>
            </div>
          </template>
        </aside>
      </section>
    </section>

    <div v-if="showSyncConfirm" class="modal-backdrop" @click.self="showSyncConfirm = false">
      <section class="sync-modal glass-surface" role="dialog" aria-modal="true" aria-labelledby="sync-title">
        <h2 id="sync-title">Forcer la sync DofusDB ?</h2>
        <p>DofusDB annonce deja les memes totaux que tes donnees locales. Tu peux quand meme relancer une synchronisation complete si tu veux repartir propre.</p>
        <div class="modal-actions">
          <button class="q-action subtle" type="button" @click="showSyncConfirm = false">Annuler</button>
          <button class="q-action" type="button" @click="syncData">Forcer la sync</button>
        </div>
      </section>
    </div>

    <div v-if="showAppUpdatePrompt && appUpdate" class="modal-backdrop" @click.self="declineAppUpdate">
      <section class="sync-modal glass-surface" role="dialog" aria-modal="true" aria-labelledby="app-update-title">
        <h2 id="app-update-title">Mettre a jour Almanax ?</h2>
        <p>
          La version {{ appUpdate.version }} est disponible. L'installation se fait en arriere-plan,
          puis l'application redemarre toute seule.
        </p>
        <p v-if="updateProgress" class="update-progress">{{ updateProgress }}</p>
        <div class="modal-actions">
          <button class="q-action subtle" type="button" :disabled="installingAppUpdate" @click="declineAppUpdate">Plus tard</button>
          <button class="q-action" type="button" :disabled="installingAppUpdate" @click="installAppUpdate">Installer</button>
        </div>
      </section>
    </div>
  </main>
</template>
