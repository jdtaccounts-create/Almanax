import { loadStoredAlmanaxData, saveStoredAlmanaxData } from './almanaxStorage'

const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const RECIPE_PAGE_LIMIT = 50
const ALMANAX_CALENDAR_PAGE_LIMIT = 50
const PAGE_CONCURRENCY = 4

export const CATEGORIES = ['Equipement', 'Consommable', 'Ressource'] as const
export type Category = typeof CATEGORIES[number]

export interface CachedItem {
  id: number
  name: string
  raw_type: string
  category: Category
  type_name?: string
  type_id?: number | null
  item_type_category_id?: number | null
  image_url: string
  image_path: string
}

export interface Recipe {
  result_id: number
  ingredient_ids: number[]
  quantities: number[]
}

export interface AlmanaxCacheEntry {
  item_id: number
  quantity: number
  checked_at?: string
}

export interface AlmanaxData {
  items: Record<string, CachedItem>
  recipes: Record<string, Recipe | null>
  almanax: Record<string, AlmanaxCacheEntry>
  metadata: Record<string, unknown>
}

export interface ItemEntry {
  item_id: number
  quantity: number
  date: string
  name: string
  category: Category
  raw_type: string
  image_url: string
  image_path: string
  order: number
  from_cache: boolean
}

export interface CraftLine {
  line_key: string
  item_id: number
  quantity: number
  name: string
  raw_type: string
  category: Category
  image_path: string
  meta: string
}

export interface CraftPlan {
  direct_crafts: CraftLine[]
  sub_crafts: CraftLine[]
  ingredients: CraftLine[]
  obtain_directly: CraftLine[]
  excluded: CraftLine[]
  dependencies: Record<string, Record<string, number>>
}

export interface DatabaseStatus {
  remoteItemTotal: number
  localItemTotal: number
  remoteRecipeTotal: number
  localRecipeTotal: number
  needsSync: boolean
  missingLabels: string[]
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function apiGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('http_get', { url: url.toString() })
    return JSON.parse(text)
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`DofusDB ${response.status} ${response.statusText}`)
  return response.json()
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function runNext(): Promise<void> {
    const index = cursor
    cursor += 1
    if (index >= items.length) return
    results[index] = await worker(items[index], index)
    await runNext()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()))
  return results
}

function localText(raw: any, key: string, fallback: string): string {
  return raw?.[key]?.fr || raw?.[key]?.en || fallback
}

function normalizeItemCategory(rawType: string): Category {
  if (rawType === 'Ressource' || rawType === 'Consommable') return rawType
  return 'Equipement'
}

function extractRawType(rawItem: any): string {
  return rawItem?.type?.superType?.name?.fr || rawItem?.type?.name?.fr || rawItem?.superType?.name?.fr || 'Equipement'
}

function normalizeApiItem(rawItem: any): CachedItem | null {
  const id = rawItem?.id
  if (id == null) return null
  const name = localText(rawItem, 'name', `Item ${id}`)
  const rawType = extractRawType(rawItem)
  const imageUrl = rawItem.img || rawItem.image || rawItem.image_url || ''
  return {
    id: Number(id),
    name,
    raw_type: rawType,
    category: normalizeItemCategory(rawType),
    type_name: rawItem?.type?.name?.fr || rawItem?.type_name || '',
    type_id: Number(rawItem?.typeId ?? rawItem?.type?.id) || null,
    item_type_category_id: Number(rawItem?.type?.categoryId) || null,
    image_url: imageUrl,
    image_path: rawItem.image_path || imageUrl,
  }
}

function normalizeRecipe(rawRecipe: any): Recipe | null {
  if (!rawRecipe || rawRecipe.resultId == null) return null
  return {
    result_id: Number(rawRecipe.resultId),
    ingredient_ids: (rawRecipe.ingredientIds || []).map(Number),
    quantities: (rawRecipe.quantities || []).map(Number),
  }
}

function idsChecksum(ids: Iterable<string>): string {
  const sorted = Array.from(ids).map(String).sort().join('\n')
  let hash = 0
  for (let index = 0; index < sorted.length; index += 1) {
    hash = Math.imul(31, hash) + sorted.charCodeAt(index)
    hash |= 0
  }
  return String(hash >>> 0)
}

async function fetchPaginated(path: string, limit: number, label: string, progress?: (message: string) => void): Promise<any[]> {
  const firstPage = await apiGet(path, { $limit: limit, $skip: 0 })
  const total = Number(firstPage.total || 0)
  const rows = [...(firstPage.data || [])]
  const pageLimit = rows.length || Number(firstPage.limit || limit) || limit
  progress?.(`${label} ${Math.min(rows.length, total)}/${total}`)

  const skips: number[] = []
  for (let skip = pageLimit; skip < total; skip += pageLimit) skips.push(skip)

  await mapWithConcurrency(skips, PAGE_CONCURRENCY, async (skip) => {
    const page = await apiGet(path, { $limit: limit, $skip: skip })
    const data = page.data || []
    rows.push(...data)
    progress?.(`${label} ${Math.min(rows.length, total)}/${total}`)
    return data.length
  })

  return rows
}

function apiDate(day: Date): string {
  return `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}/${day.getFullYear()}`
}

function displayDate(date: string): string {
  const [month, day, year] = date.split('/')
  return `${day}/${month}/${year}`
}

function parseApiDate(value: string): Date {
  const [month, day, year] = value.split('/').map(Number)
  return new Date(year, month - 1, day)
}

function addDays(day: Date, count: number): Date {
  const next = new Date(day)
  next.setDate(next.getDate() + count)
  return next
}

function internalExact(day: Date): string {
  return `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}/${day.getFullYear()}`
}

function internalWildcard(day: Date): string {
  return `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}/*`
}

function wildcardQuery(day: Date): string {
  return `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}/*`
}

const almanaxDayCache = new Map<string, any>()
let almanaxCalendarsPromise: Promise<any[]> | null = null

async function getAlmanaxDay(dateQuery: string): Promise<any> {
  if (!almanaxDayCache.has(dateQuery)) {
    almanaxDayCache.set(dateQuery, await apiGet('/almanax', { date: dateQuery }))
  }
  return almanaxDayCache.get(dateQuery)
}

async function getAlmanaxCalendars(): Promise<any[]> {
  almanaxCalendarsPromise ||= fetchPaginated('/almanax-calendars', ALMANAX_CALENDAR_PAGE_LIMIT, 'Calendrier')
  return almanaxCalendarsPromise
}

function hasOffering(raw: any): boolean {
  return Boolean(raw?.itemIds?.length && raw?.quantities?.length)
}

async function resolveCalendarWildcard(day: Date, targetWildcard: string): Promise<any | null> {
  const calendars = await getAlmanaxCalendars()
  const matches = calendars.filter((candidate) => hasOffering(candidate) && (candidate?.dates || []).includes(targetWildcard))
  if (matches.length === 1) return matches[0]
  if (!matches.length) return null

  const wildcardDay = await getAlmanaxDay(wildcardQuery(day)).catch(() => null)
  const wildcardDates: string[] = wildcardDay?.dates || []
  if (hasOffering(wildcardDay) && wildcardDates.includes(targetWildcard)) return wildcardDay

  return matches.find((candidate) => (candidate?.dates || []).length === 1) || matches[0]
}

async function resolveAlmanaxDay(date: string): Promise<any> {
  const day = parseApiDate(date)
  const targetExact = internalExact(day)
  const targetWildcard = internalWildcard(day)

  const calendarCandidate = await resolveCalendarWildcard(day, targetWildcard).catch(() => null)
  if (calendarCandidate) return calendarCandidate

  const wildcardCandidate = await getAlmanaxDay(wildcardQuery(day))
  const wildcardDates: string[] = wildcardCandidate?.dates || []
  if (hasOffering(wildcardCandidate) && wildcardDates.includes(targetWildcard)) return wildcardCandidate

  const exactCandidate = await getAlmanaxDay(apiDate(day))
  const exactDates: string[] = exactCandidate?.dates || []
  if (hasOffering(exactCandidate) && exactDates.includes(targetExact)) return exactCandidate

  return exactCandidate || wildcardCandidate
}

function dateRange(start: string, end: string): string[] {
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = new Date(`${end}T00:00:00`)
  if (endDate < startDate) return []
  const dates: string[] = []
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    dates.push(apiDate(day))
  }
  return dates
}

function currentMonthRange(): { start: string; end: string } {
  const today = new Date()
  const start = today.toISOString().slice(0, 10)
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

function makeEntry(data: AlmanaxData, date: string, cached: AlmanaxCacheEntry, order: number, fromCache: boolean): ItemEntry | null {
  const item = data.items[String(cached.item_id)]
  if (!item) return null
  const displayType = item.type_name || item.raw_type
  return {
    item_id: cached.item_id,
    quantity: cached.quantity,
    date,
    name: item.name,
    category: item.category,
    raw_type: displayType,
    image_url: item.image_url,
    image_path: item.image_url || item.image_path,
    order,
    from_cache: fromCache,
  }
}

export async function loadAlmanaxData(): Promise<AlmanaxData> {
  const stored = await loadStoredAlmanaxData().catch(() => null)
  if (stored) return stored

  const [items, recipes, almanax, metadata] = await Promise.all([
    fetch('/data/items.json').then((response) => response.json()).catch(() => ({})),
    fetch('/data/recipes.json').then((response) => response.json()).catch(() => ({})),
    fetch('/data/almanax.json').then((response) => response.json()).catch(() => ({})),
    fetch('/data/metadata.json').then((response) => response.json()).catch(() => ({})),
  ])

  return { items, recipes, almanax, metadata }
}

export function selectedApiDates(start: string, end: string): string[] {
  return dateRange(start, end)
}

export function defaultPeriod(): { start: string; end: string } {
  return currentMonthRange()
}

export function loadCachedEntries(data: AlmanaxData, dates: string[]): ItemEntry[] {
  return dates
    .map((date, order) => {
      const cached = data.almanax[date]
      return cached ? makeEntry(data, date, cached, order, true) : null
    })
    .filter((entry): entry is ItemEntry => Boolean(entry))
}

async function fetchItemById(itemId: number): Promise<CachedItem | null> {
  const result = await apiGet('/items', { id: itemId })
  return normalizeApiItem(result?.data?.[0])
}

function needsItemDetailRefresh(data: AlmanaxData, itemId: number): boolean {
  const item = data.items[String(itemId)]
  return !item || (!item.type_name && (item.raw_type === 'Ressource' || item.raw_type === 'Consommable'))
}

export async function refreshItemDetails(data: AlmanaxData, itemIds: number[], progress?: (message: string) => void): Promise<void> {
  const ids = Array.from(new Set(itemIds.filter((itemId) => needsItemDetailRefresh(data, itemId))))
  await mapWithConcurrency(ids, PAGE_CONCURRENCY, async (itemId, index) => {
    progress?.(`Types ${index + 1}/${ids.length}`)
    const item = await fetchItemById(itemId)
    if (item) data.items[String(itemId)] = item
  })
}

export async function refreshAlmanaxEntries(data: AlmanaxData, dates: string[], progress?: (message: string) => void): Promise<ItemEntry[]> {
  const refreshed = await mapWithConcurrency(dates, 6, async (date, index) => {
    const raw = await resolveAlmanaxDay(date)
    progress?.(`Almanax ${index + 1}/${dates.length}`)
    const entry = {
      item_id: Number(raw.itemIds?.[0]),
      quantity: Number(raw.quantities?.[0]),
      checked_at: new Date().toISOString(),
    }
    data.almanax[date] = entry
    return entry
  })

  await refreshItemDetails(data, refreshed.map((entry) => entry.item_id), progress)

  data.metadata = { ...data.metadata, last_almanax_sync: new Date().toISOString() }
  await saveStoredAlmanaxData(data)
  return loadCachedEntries(data, dates)
}

export async function syncAlmanaxData(progress?: (message: string) => void): Promise<AlmanaxData> {
  const [rawItems, rawRecipes] = await Promise.all([
    fetchPaginated('/items', PAGE_LIMIT, 'Items', progress),
    fetchPaginated('/recipes', RECIPE_PAGE_LIMIT, 'Recettes', progress),
  ])

  const normalizedItems = rawItems.map(normalizeApiItem).filter((item): item is CachedItem => Boolean(item))
  const items = Object.fromEntries(normalizedItems.map((item) => [String(item.id), item]))
  const normalizedRecipes = rawRecipes.map(normalizeRecipe).filter((recipe): recipe is Recipe => Boolean(recipe))
  const recipes = Object.fromEntries(normalizedRecipes.map((recipe) => [String(recipe.result_id), recipe]))
  const previous = await loadAlmanaxData().catch(() => ({ almanax: {} }))

  const data: AlmanaxData = {
    items,
    recipes,
    almanax: previous.almanax || {},
    metadata: {
      item_total: Object.keys(items).length,
      recipe_total: Object.keys(recipes).length,
      item_ids_checksum: idsChecksum(Object.keys(items)),
      recipe_ids_checksum: idsChecksum(Object.keys(recipes)),
      last_sync: new Date().toISOString(),
    },
  }

  await saveStoredAlmanaxData(data)
  progress?.(`Données synchronisées : ${Object.keys(items).length} items, ${Object.keys(recipes).length} recettes`)
  return data
}

export async function checkAlmanaxDataStatus(data: AlmanaxData): Promise<DatabaseStatus> {
  const [itemPage, recipePage] = await Promise.all([
    apiGet('/items', { $limit: 1, $skip: 0 }),
    apiGet('/recipes', { $limit: 1, $skip: 0 }),
  ])

  const status = {
    remoteItemTotal: Number(itemPage.total || 0),
    localItemTotal: Object.keys(data.items).length,
    remoteRecipeTotal: Number(recipePage.total || 0),
    localRecipeTotal: Object.keys(data.recipes).length,
  }
  const missingLabels: string[] = []
  if (status.remoteItemTotal !== status.localItemTotal) missingLabels.push('items')
  if (status.remoteRecipeTotal !== status.localRecipeTotal) missingLabels.push('recettes')
  return { ...status, missingLabels, needsSync: missingLabels.length > 0 }
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function isRecipeExcluded(item: CachedItem | undefined): boolean {
  return normalizeText(item?.name || '').includes('eklame')
}

function mergeQuantity(target: Map<number, number>, itemId: number, quantity: number): void {
  target.set(itemId, (target.get(itemId) || 0) + quantity)
}

function lineFor(data: AlmanaxData, kind: string, itemId: number, quantity: number, meta: string): CraftLine {
  const item = data.items[String(itemId)]
  return {
    line_key: `${kind}:${itemId}`,
    item_id: itemId,
    quantity,
    name: item?.name || `Item ${itemId}`,
    raw_type: item?.type_name || item?.raw_type || 'Item',
    category: item?.category || 'Ressource',
    image_path: item?.image_url || item?.image_path || '',
    meta,
  }
}

function linesFromMap(data: AlmanaxData, kind: string, values: Map<number, number>, meta: string): CraftLine[] {
  return Array.from(values.entries()).map(([itemId, quantity]) => lineFor(data, kind, itemId, quantity, meta))
}

export function buildCraftPlan(data: AlmanaxData, entries: ItemEntry[]): CraftPlan {
  const directCrafts = new Map<number, number>()
  const subCrafts = new Map<number, number>()
  const ingredients = new Map<number, number>()
  const obtainDirectly = new Map<number, number>()
  const excluded = new Map<number, number>()
  const dependencies: Record<string, Record<string, number>> = {}
  const baseIds = new Set(entries.map((entry) => entry.item_id))

  const mergeDeps = (target: Record<string, number>, source: Record<string, number>) => {
    Object.entries(source).forEach(([itemId, quantity]) => {
      target[itemId] = (target[itemId] || 0) + Number(quantity)
    })
  }

  function expand(itemId: number, quantity: number, stack = new Set<number>()): Record<string, number> {
    const item = data.items[String(itemId)]
    const recipe = data.recipes[String(itemId)]
    if (!recipe || isRecipeExcluded(item) || stack.has(itemId)) {
      mergeQuantity(recipe && isRecipeExcluded(item) ? excluded : obtainDirectly, itemId, quantity)
      return { [String(itemId)]: quantity }
    }

    const isBase = baseIds.has(itemId)
    mergeQuantity(isBase ? directCrafts : subCrafts, itemId, quantity)
    const lineKey = `${isBase ? 'direct_crafts' : 'sub_crafts'}:${itemId}`
    dependencies[lineKey] ||= {}

    const nextStack = new Set(stack)
    nextStack.add(itemId)

    recipe.ingredient_ids.forEach((ingredientId, index) => {
      const needed = quantity * Number(recipe.quantities[index] || 1)
      dependencies[lineKey][String(ingredientId)] = (dependencies[lineKey][String(ingredientId)] || 0) + needed
      mergeQuantity(ingredients, ingredientId, needed)
      mergeDeps(dependencies[lineKey], expand(ingredientId, needed, nextStack))
    })

    return { ...dependencies[lineKey] }
  }

  entries.forEach((entry) => expand(entry.item_id, entry.quantity))

  return {
    direct_crafts: linesFromMap(data, 'direct_crafts', directCrafts, 'Offrande craftable'),
    sub_crafts: linesFromMap(data, 'sub_crafts', subCrafts, 'Sous-craft'),
    ingredients: linesFromMap(data, 'ingredients', ingredients, 'Ressource utile aux crafts'),
    obtain_directly: linesFromMap(data, 'obtain_directly', obtainDirectly, 'A obtenir directement'),
    excluded: linesFromMap(data, 'excluded', excluded, 'Recette exclue'),
    dependencies,
  }
}

export { displayDate, saveStoredAlmanaxData }


