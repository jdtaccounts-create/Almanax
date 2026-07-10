import {
  loadCachedImageIds,
  loadFailedCachedImages,
  loadSharedCatalog,
  loadStoredAlmanaxData,
  pruneCachedImages,
  saveCachedImage,
  saveFailedCachedImages,
  saveSharedCatalog,
  saveStoredAlmanaxData,
  type FailedCachedImage,
} from './almanaxStorage'

const API_URL = 'https://api.dofusdb.fr'
const DOFUSDUDE_API_URL = 'https://api.dofusdu.de'
const DEV_API_PROXY = '/dofusdb-api'
const DEV_DOFUSDUDE_PROXY = '/dofusdude-api'
const PAGE_LIMIT = 50
const RECIPE_PAGE_LIMIT = 50
const SHARED_DOFUSDB_CONCURRENCY = 8
const ALMANAX_ENTRY_CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 8_000
const ESTIMATED_JSON_COMPRESSION_RATIO = 0.16
const ESTIMATED_IMAGE_BYTES = 40 * 1024
const FAILED_IMAGE_RETRY_MS = 24 * 60 * 60 * 1000
const TRANSIENT_FAILED_IMAGE_RETRY_MS = 15 * 60 * 1000

export const CATEGORIES = ['Equipement', 'Consommable', 'Ressource'] as const
export type Category = typeof CATEGORIES[number]

export type AlmanaxSyncEndpoint = 'items' | 'recipes' | 'itemSets'

export type AlmanaxSyncProgressEvent =
  | { kind: 'endpoint'; endpoint: AlmanaxSyncEndpoint; label: string; done: number; total: number; bytesDone: number }
  | { kind: 'images'; done: number; total: number; bytesDone: number; bytesTotal?: number }
  | { kind: 'message'; message: string }

export type AlmanaxSyncProgress = (event: AlmanaxSyncProgressEvent | string) => void

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

export interface HarvestableResource {
  item_id: number
  job: string
  rarity: 'normal' | 'rare' | 'meat'
  source_item_id?: number
  source_monster_id?: number
  source_monster_name?: string
  order: number
}

export interface ResourceOrigin {
  item_id: number
  origins: Array<{
    monster_id: number
    monster_name: string
    race_id: number | null
    race_name: string
    super_race_id: number | null
    super_race_name: string
    min_level: number | null
    max_level: number | null
    drop_rate: number
    has_criterions: boolean
  }>
}

export interface SortMetadata {
  harvestables: Record<string, HarvestableResource>
  resourceOrigins: Record<string, ResourceOrigin>
}

export interface Recipe {
  result_id: number
  ingredient_ids: number[]
  quantities: number[]
}

export interface ItemSet {
  id: number
  name: string
  name_norm: string
  compact: string
  item_ids: number[]
}

export interface AlmanaxCacheEntry {
  item_id: number
  quantity: number
  checked_at?: string
}

interface DofusdudeAlmanax {
  date: string
  tribute?: {
    quantity?: number
    item?: {
      ankama_id?: number
      name?: string
      subtype?: string
      image_urls?: {
        icon?: string
        sd?: string
        hq?: string
        hd?: string
      }
    }
  }
}

export interface AlmanaxData {
  items: Record<string, CachedItem>
  recipes: Record<string, Recipe | null>
  almanax: Record<string, AlmanaxCacheEntry>
  metadata: Record<string, unknown>
  sortMetadata?: SortMetadata
  itemSets?: Record<string, ItemSet>
}

interface SharedCatalogData {
  items?: Record<string, CachedItem>
  recipes?: Record<string, Recipe>
  itemSets?: Record<string, ItemSet>
  metadata?: Record<string, unknown>
  sortMetadata?: SortMetadata
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
  remoteItemSetTotal: number
  localItemSetTotal: number
  missingImageGroups: number
  needsSync: boolean
  missingLabels: string[]
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function isRemoteImagePath(path: string | undefined): boolean {
  return /^https?:\/\//.test(path || '')
}

function itemImageSource(item: CachedItem): string {
  if (isRemoteImagePath(item.image_url)) return item.image_url || ''
  return isRemoteImagePath(item.image_path) ? item.image_path : ''
}

export function groupMissingImages(data: AlmanaxData, cachedIds: ReadonlySet<number>): Array<[string, CachedItem[]]> {
  const missingBySource = Object.values(data.items || {}).reduce((groups, item) => {
    const source = itemImageSource(item)
    if (!source || cachedIds.has(item.id)) return groups
    const group = groups.get(source) || []
    group.push(item)
    groups.set(source, group)
    return groups
  }, new Map<string, CachedItem[]>())
  return [...missingBySource.entries()]
}

function failedImageRetryMs(row: FailedCachedImage): number {
  return /failed to fetch|timeout|network|abort/i.test(row.reason || '')
    ? TRANSIENT_FAILED_IMAGE_RETRY_MS
    : FAILED_IMAGE_RETRY_MS
}

function isTransientImageFailure(row: FailedCachedImage): boolean {
  return failedImageRetryMs(row) === TRANSIENT_FAILED_IMAGE_RETRY_MS
}

function isRecentFailedImage(row: FailedCachedImage, now = Date.now()): boolean {
  return now - Date.parse(row.failedAt) < failedImageRetryMs(row)
}

function recentFailedImageIds(rows: FailedCachedImage[] | null, now = Date.now()): Set<number> {
  return new Set((rows || [])
    .filter((row) => isRecentFailedImage(row, now))
    .map((row) => row.itemId))
}

function mergeFailedImages(previous: FailedCachedImage[] | null, next: FailedCachedImage[]): FailedCachedImage[] {
  const recent = (previous || []).filter((row) => isRecentFailedImage(row))
  const byId = new Map(recent.map((row) => [row.itemId, row]))
  next.forEach((row) => byId.set(row.itemId, row))
  return [...byId.values()]
}

function estimatedCompressedJsonBytes(text: string, fallbackBytes?: number | null): number {
  const knownBytes = Number(fallbackBytes || 0)
  if (knownBytes > 0) return knownBytes
  return Math.max(1, Math.round(new Blob([text]).size * ESTIMATED_JSON_COMPRESSION_RATIO))
}

function browserProxyUrl(url: URL, proxyBase: string): string {
  const localProxy =
    typeof window !== 'undefined'
    && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  return localProxy ? `${proxyBase}${url.pathname}${url.search}` : url.toString()
}

async function apiGetPayload(path: string, params: Record<string, string | number> = {}): Promise<{ data: any; bytes: number }> {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('http_get', { url: url.toString() })
    return { data: JSON.parse(text), bytes: estimatedCompressedJsonBytes(text) }
  }

  const browserUrl = browserProxyUrl(url, DEV_API_PROXY)
  const response = await fetch(browserUrl, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`DofusDB ${response.status} ${response.statusText}`)
  const text = await response.text()
  const headerBytes = Number(response.headers.get('content-length') || 0)
  const timingEntries = performance
    .getEntriesByName(browserUrl)
    .filter((entry): entry is PerformanceResourceTiming => 'encodedBodySize' in entry)
  const timingBytes = timingEntries.length ? timingEntries[timingEntries.length - 1].encodedBodySize : 0
  return { data: JSON.parse(text), bytes: estimatedCompressedJsonBytes(text, headerBytes || timingBytes || 0) }
}

async function apiGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  return (await apiGetPayload(path, params)).data
}

async function dofusdudeGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(`${DOFUSDUDE_API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('http_get', { url: url.toString() })
    return JSON.parse(text)
  }

  const browserUrl = browserProxyUrl(url, DEV_DOFUSDUDE_PROXY)
  const response = await fetch(browserUrl)
  if (!response.ok) throw new Error(`Dofusdude ${response.status} ${response.statusText}`)
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

function isLocalImagePath(path: string | undefined): boolean {
  return Boolean(path && /^https?:\/\//.test(path))
}

function normalizeApiItem(rawItem: any, previous?: CachedItem): CachedItem | null {
  const id = rawItem?.id
  if (id == null) return null
  const name = localText(rawItem, 'name', `Item ${id}`)
  const rawType = extractRawType(rawItem)
  const imageUrl = rawItem.img || rawItem.image || rawItem.image_url || ''
  const localImagePath = isLocalImagePath(previous?.image_path)
    ? previous?.image_path
    : isLocalImagePath(rawItem.image_path)
      ? rawItem.image_path
      : ''
  return {
    id: Number(id),
    name,
    raw_type: rawType,
    category: normalizeItemCategory(rawType),
    type_name: rawItem?.type?.name?.fr || rawItem?.type_name || '',
    type_id: Number(rawItem?.typeId ?? rawItem?.type?.id) || null,
    item_type_category_id: Number(rawItem?.type?.categoryId) || null,
    image_url: imageUrl,
    image_path: localImagePath || '',
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

function compactText(value: string): string {
  return normalizeText(value).replace(/\s/g, '')
}

function normalizeSet(rawSet: any): ItemSet | null {
  if (rawSet?.id == null) return null
  const name = rawSet.name?.fr || rawSet.slug?.fr || `Panoplie ${rawSet.id}`
  return {
    id: Number(rawSet.id),
    name,
    name_norm: normalizeText(name),
    compact: compactText(name),
    item_ids: (rawSet.items || []).map((item: any) => Number(item.id)).filter(Number.isFinite),
  }
}

function dofusdudeAlmanaxCache(previous: Partial<AlmanaxData> = {}): Record<string, AlmanaxCacheEntry> {
  return previous.metadata?.almanax_source === 'dofusdude' ? previous.almanax || {} : {}
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

function latestUpdatedAt(rows: any[]): string {
  return rows.reduce((latest, row) => {
    const value = String(row?.updatedAt || '')
    return value > latest ? value : latest
  }, '')
}

async function endpointInfo(path: string): Promise<{ total: number; latestUpdatedAt: string }> {
  const page = await apiGet(path, { $limit: 1, $skip: 0, '$sort[updatedAt]': -1 })
  return {
    total: Number(page.total || 0),
    latestUpdatedAt: String(page.data?.[0]?.updatedAt || ''),
  }
}

function localRemoteMetadata(data: AlmanaxData, sharedCatalog: SharedCatalogData | null, endpoint: 'items' | 'recipes' | 'itemSets'): { total: number; latestUpdatedAt: string } {
  if (data.metadata?.shared_sync_state === 'bootstrap' || sharedCatalog?.metadata?.shared_sync_state === 'bootstrap') {
    return { total: 0, latestUpdatedAt: '' }
  }
  const remote = (data.metadata?.remote || sharedCatalog?.metadata?.remote) as Record<string, { total?: number; latestUpdatedAt?: string }> | undefined
  const totalKeys = {
    items: 'item_total',
    recipes: 'recipe_total',
    itemSets: 'item_set_total',
  }
  const fallbackTotals = {
    items: Object.keys(data.items || sharedCatalog?.items || {}).length,
    recipes: Object.keys(data.recipes || sharedCatalog?.recipes || {}).length,
    itemSets: Object.keys(data.itemSets || sharedCatalog?.itemSets || {}).length,
  }
  return {
    total: Number(remote?.[endpoint]?.total || data.metadata?.[totalKeys[endpoint]] || sharedCatalog?.metadata?.[totalKeys[endpoint]] || 0) || fallbackTotals[endpoint],
    latestUpdatedAt: String(remote?.[endpoint]?.latestUpdatedAt || ''),
  }
}

async function fetchPaginated(path: string, limit: number, endpoint: AlmanaxSyncEndpoint, label: string, progress?: AlmanaxSyncProgress): Promise<any[]> {
  const firstPayload = await apiGetPayload(path, { $limit: limit, $skip: 0 })
  const firstPage = firstPayload.data
  const total = Number(firstPage.total || 0)
  const rows = [...(firstPage.data || [])]
  const pageLimit = rows.length || Number(firstPage.limit || limit) || limit
  let bytesDone = firstPayload.bytes
  progress?.({ kind: 'endpoint', endpoint, label, done: Math.min(rows.length, total), total, bytesDone })

  const skips: number[] = []
  for (let skip = pageLimit; skip < total; skip += pageLimit) skips.push(skip)

  await mapWithConcurrency(skips, SHARED_DOFUSDB_CONCURRENCY, async (skip) => {
    const payload = await apiGetPayload(path, { $limit: limit, $skip: skip })
    const page = payload.data
    const data = page.data || []
    rows.push(...data)
    bytesDone += payload.bytes
    progress?.({ kind: 'endpoint', endpoint, label, done: Math.min(rows.length, total), total, bytesDone })
    return data.length
  })

  if (rows.length !== total) {
    throw new Error(`${label}: ${rows.length} lignes recues pour ${total} attendues`)
  }

  return rows
}

function apiDate(day: Date): string {
  return `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}/${day.getFullYear()}`
}

function dofusdudeDate(day: Date): string {
  return localIsoDate(day)
}

function localIsoDate(day: Date): string {
  const year = day.getFullYear()
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
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

async function fetchDofusdudeAlmanax(day: Date): Promise<DofusdudeAlmanax> {
  return dofusdudeGet(`/dofus3/v1/fr/almanax/${dofusdudeDate(day)}`)
}

async function refreshAlmanaxDay(data: AlmanaxData, date: string): Promise<void> {
  const day = parseApiDate(date)
  const almanax = await fetchDofusdudeAlmanax(day)
  const itemId = Number(almanax.tribute?.item?.ankama_id)
  const quantity = Number(almanax.tribute?.quantity)
  if (!Number.isFinite(itemId) || !Number.isFinite(quantity)) {
    throw new Error(`Offrande Dofusdude invalide pour ${dofusdudeDate(day)}`)
  }

  await refreshItemDetails(data, [itemId])
  data.almanax[date] = {
    item_id: itemId,
    quantity,
    checked_at: new Date().toISOString(),
  }
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
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  return { start: localIsoDate(today), end: localIsoDate(endDate) }
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
    image_path: item.image_path,
    order,
    from_cache: fromCache,
  }
}

async function loadBundledAlmanaxData(previous: Partial<AlmanaxData> = {}): Promise<AlmanaxData> {
  const [metadata, sortMetadata] = await Promise.all([
    fetch('/data/metadata.json').then((response) => response.json()).catch(() => ({})),
    loadSortMetadata(),
  ])

  return {
    items: {},
    recipes: {},
    itemSets: {},
    almanax: dofusdudeAlmanaxCache(previous),
    metadata: { ...metadata, almanax_source: 'dofusdude', shared_sync_state: 'bootstrap' },
    ...sortMetadata,
  }
}

function stripBundledImagePaths<T extends { items?: Record<string, CachedItem> }>(data: T): { data: T; changed: boolean } {
  let changed = false
  const items = Object.fromEntries(Object.entries(data.items || {}).map(([id, item]) => {
    if (!item.image_path || item.image_path.startsWith('http://') || item.image_path.startsWith('https://')) return [id, item]
    changed = true
    return [id, { ...item, image_path: '' }]
  }))
  return { data: changed ? { ...data, items } : data, changed }
}

async function loadSortMetadata(): Promise<Pick<AlmanaxData, 'sortMetadata'>> {
  const [harvestables, resourceOrigins] = await Promise.all([
    fetch('/data/harvestable_resources.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, HarvestableResource>>,
    fetch('/data/resource_origins.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, ResourceOrigin>>,
  ])
  return { sortMetadata: { harvestables, resourceOrigins } }
}

function normalizeSharedItems(items: Record<string, CachedItem> | undefined): Record<string, CachedItem> | null {
  if (!items || !Object.keys(items).length) return null
  return Object.fromEntries(Object.entries(items).map(([id, item]) => {
    const rawType = item.raw_type || 'Equipement'
    return [id, {
      ...item,
      id: Number(item.id ?? id),
      name: item.name || `Item ${id}`,
      raw_type: rawType,
      category: item.category || normalizeItemCategory(rawType),
      type_name: item.type_name || '',
      image_url: item.image_url || '',
      image_path: item.image_path?.startsWith('http') ? item.image_path : '',
    }]
  }))
}

function applySharedCatalog(data: AlmanaxData, shared: SharedCatalogData | null): AlmanaxData {
  const items = normalizeSharedItems(shared?.items)
  if (shared?.metadata?.shared_sync_state !== 'complete' || !items || !shared?.recipes || !Object.keys(shared.recipes).length) return {
    ...data,
    items: {},
    recipes: {},
    itemSets: {},
    metadata: {
      ...data.metadata,
      shared_sync_state: 'bootstrap',
    },
  }
  return {
    ...data,
    items,
    recipes: shared.recipes,
    itemSets: shared.itemSets || data.itemSets,
    metadata: {
      ...data.metadata,
      ...(shared.metadata || {}),
      almanax_source: data.metadata?.almanax_source || 'dofusdude',
    },
    sortMetadata: shared.sortMetadata || data.sortMetadata,
  }
}

function toSharedCatalog(data: AlmanaxData, previous: SharedCatalogData | null): SharedCatalogData {
  const recipes = Object.fromEntries(Object.entries(data.recipes || {}).filter((entry): entry is [string, Recipe] => Boolean(entry[1])))
  const sharedItems = stripBundledImagePaths({ items: data.items }).data.items || {}
  const remote = data.metadata?.remote || previous?.metadata?.remote
  return {
    ...(previous || {}),
    items: sharedItems,
    recipes,
    itemSets: data.itemSets || previous?.itemSets || {},
    metadata: {
      ...(previous?.metadata || {}),
      item_total: Object.keys(data.items || {}).length,
      recipe_total: Object.keys(recipes).length,
      item_set_total: Object.keys(data.itemSets || previous?.itemSets || {}).length,
      last_sync: data.metadata?.last_sync || new Date().toISOString(),
      remote,
      shared_sync_state: data.metadata?.shared_sync_state || (remote ? 'complete' : 'bootstrap'),
    },
    sortMetadata: data.sortMetadata,
  }
}

export async function loadAlmanaxData(): Promise<AlmanaxData> {
  const stored = await loadStoredAlmanaxData().catch(() => null)
  const sharedCatalog = await loadSharedCatalog<SharedCatalogData>().catch(() => null)
  const sortMetadata = await loadSortMetadata()
  if (stored) {
    try {
      const bundledMetadata = await fetch('/data/metadata.json').then((response) => response.json())
      const normalizedStored = stripBundledImagePaths(stored)
      const storedWithDefaults = applySharedCatalog({
        ...normalizedStored.data,
        almanax: dofusdudeAlmanaxCache(normalizedStored.data),
        metadata: normalizedStored.data.metadata || {},
        ...sortMetadata,
      }, sharedCatalog)
      const bundledIsNewer =
        Number(bundledMetadata.item_total || 0) > Object.keys(storedWithDefaults.items || {}).length
        || Number(bundledMetadata.recipe_total || 0) > Object.keys(storedWithDefaults.recipes || {}).length

      if (!bundledIsNewer) {
        if (normalizedStored.changed) void saveStoredAlmanaxData(storedWithDefaults).catch(() => {})
        return storedWithDefaults
      }
      const bundled = stripBundledImagePaths(await loadBundledAlmanaxData(storedWithDefaults)).data
      return applySharedCatalog(bundled, sharedCatalog)
    } catch {
      return applySharedCatalog({
        ...stored,
        almanax: dofusdudeAlmanaxCache(stored),
        metadata: { ...(stored.metadata || {}), almanax_source: 'dofusdude' },
        ...sortMetadata,
      }, sharedCatalog)
    }
  }

  const bundled = stripBundledImagePaths(await loadBundledAlmanaxData()).data
  return applySharedCatalog(bundled, sharedCatalog)
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

async function fetchItemById(itemId: number, previous?: CachedItem): Promise<CachedItem | null> {
  const result = await apiGet('/items', { id: itemId })
  return normalizeApiItem(result?.data?.[0], previous)
}

function needsItemDetailRefresh(data: AlmanaxData, itemId: number): boolean {
  const item = data.items[String(itemId)]
  return !item || (!item.type_name && (item.raw_type === 'Ressource' || item.raw_type === 'Consommable'))
}

export async function refreshItemDetails(data: AlmanaxData, itemIds: number[], progress?: (message: string) => void): Promise<void> {
  const ids = Array.from(new Set(itemIds.filter((itemId) => needsItemDetailRefresh(data, itemId))))
  await mapWithConcurrency(ids, SHARED_DOFUSDB_CONCURRENCY, async (itemId, index) => {
    progress?.(`Types ${index + 1}/${ids.length}`)
    const item = await fetchItemById(itemId, data.items[String(itemId)])
    if (item) data.items[String(itemId)] = item
  })
}

export async function refreshAlmanaxEntries(data: AlmanaxData, dates: string[], progress?: (message: string) => void): Promise<ItemEntry[]> {
  await mapWithConcurrency(dates, ALMANAX_ENTRY_CONCURRENCY, async (date, index) => {
    progress?.(`Almanax ${index + 1}/${dates.length}`)
    await refreshAlmanaxDay(data, date)
  })
  data.metadata = { ...data.metadata, last_almanax_sync: new Date().toISOString(), almanax_source: 'dofusdude' }
  await saveStoredAlmanaxData(data)
  return loadCachedEntries(data, dates)
}

export async function syncAlmanaxData(progress?: AlmanaxSyncProgress): Promise<AlmanaxData> {
  const [rawItems, rawRecipes, rawSets] = await Promise.all([
    fetchPaginated('/items', PAGE_LIMIT, 'items', 'Items', progress),
    fetchPaginated('/recipes', RECIPE_PAGE_LIMIT, 'recipes', 'Recettes', progress),
    fetchPaginated('/item-sets', PAGE_LIMIT, 'itemSets', 'Panoplies', progress),
  ])

  const previous: Partial<AlmanaxData> = await loadAlmanaxData().catch(() => ({ almanax: {}, metadata: {} }))
  const previousItems = previous.items || {}
  const sortMetadata = previous.sortMetadata ? { sortMetadata: previous.sortMetadata } : await loadSortMetadata()
  const normalizedItems = rawItems.map((rawItem) =>
    normalizeApiItem(rawItem, previousItems[String(rawItem?.id)]),
  ).filter((item): item is CachedItem => Boolean(item))
  const items = Object.fromEntries(normalizedItems.map((item) => [String(item.id), item]))
  const normalizedRecipes = rawRecipes.map(normalizeRecipe).filter((recipe): recipe is Recipe => Boolean(recipe))
  const recipes = Object.fromEntries(normalizedRecipes.map((recipe) => [String(recipe.result_id), recipe]))
  const normalizedSets = rawSets.map(normalizeSet).filter((itemSet): itemSet is ItemSet => Boolean(itemSet))
  const itemSets = Object.fromEntries(normalizedSets.map((itemSet) => [String(itemSet.id), itemSet]))

  const data: AlmanaxData = {
    items,
    recipes,
    itemSets,
    almanax: dofusdudeAlmanaxCache(previous),
    metadata: {
      item_total: Object.keys(items).length,
      recipe_total: Object.keys(recipes).length,
      item_set_total: Object.keys(itemSets).length,
      item_ids_checksum: idsChecksum(Object.keys(items)),
      recipe_ids_checksum: idsChecksum(Object.keys(recipes)),
      almanax_source: 'dofusdude',
      last_sync: new Date().toISOString(),
      remote: {
        items: { total: Object.keys(items).length, latestUpdatedAt: latestUpdatedAt(rawItems) },
        recipes: { total: Object.keys(recipes).length, latestUpdatedAt: latestUpdatedAt(rawRecipes) },
        itemSets: { total: Object.keys(itemSets).length, latestUpdatedAt: latestUpdatedAt(rawSets) },
      },
      shared_sync_state: 'complete',
    },
    ...sortMetadata,
  }

  await saveStoredAlmanaxData(data)
  await saveSharedCatalog(toSharedCatalog(data, await loadSharedCatalog<SharedCatalogData>().catch(() => null))).catch(() => {})
  progress?.({ kind: 'message', message: `Données synchronisées : ${Object.keys(items).length} items, ${Object.keys(recipes).length} recettes, ${Object.keys(itemSets).length} panoplies` })
  return data
}

export async function syncAlmanaxImages(
  data: AlmanaxData,
  progress?: AlmanaxSyncProgress,
): Promise<Map<number, string>> {
  const cachedIds = await loadCachedImageIds()
  const previousFailures = await loadFailedCachedImages().catch(() => null)
  const ignoredImageIds = recentFailedImageIds(previousFailures)
  const missing = groupMissingImages(data, new Set([...cachedIds, ...ignoredImageIds]))
  let cursor = 0
  let completed = 0
  let bytesDone = 0
  let successful = 0
  let bytesTotal = missing.length * ESTIMATED_IMAGE_BYTES
  const failures: FailedCachedImage[] = []
  progress?.({ kind: 'images', done: 0, total: missing.length, bytesDone, bytesTotal })
  await Promise.all(Array.from({ length: Math.min(SHARED_DOFUSDB_CONCURRENCY, missing.length) }, async () => {
    while (cursor < missing.length) {
      const [source, items] = missing[cursor++]
      const savedItemIds = new Set<number>()
      try {
        const response = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`Image ${response.status}`)
        const blob = await response.blob()
        bytesDone += blob.size
        successful += 1
        if (successful > 0) bytesTotal = Math.max(bytesDone, (bytesDone / successful) * missing.length)
        for (const item of items) {
          await saveCachedImage(item.id, blob)
          savedItemIds.add(item.id)
        }
      } catch (error) {
        const failedItems = items.filter((item) => !savedItemIds.has(item.id))
        if (failedItems.length) {
          const reason = String(error)
          console.warn('[Almanax] image sync failed', {
            source,
            reason,
            items: failedItems.map((item) => ({ id: item.id, name: item.name })),
          })
          failures.push(...failedItems.map((item) => ({ itemId: item.id, source, failedAt: new Date().toISOString(), reason })))
        }
      } finally {
        completed += 1
        if (completed % 50 === 0 || completed === missing.length || completed === 1 || missing.length - completed <= 50) {
          progress?.({ kind: 'images', done: completed, total: missing.length, bytesDone, bytesTotal })
        }
      }
    }
  }))
  const transientFailures = failures.filter(isTransientImageFailure)
  const durableFailures = failures.filter((row) => !isTransientImageFailure(row))
  if (transientFailures.length) {
    throw new Error(`Connexion interrompue : ${transientFailures.length} images restent à télécharger`)
  }
  const validItemIds = Object.keys(data.items).map(Number)
  const validItemIdSet = new Set(validItemIds)
  const nextFailures = mergeFailedImages(previousFailures, durableFailures).filter((row) => validItemIdSet.has(row.itemId))
  if (durableFailures.length || nextFailures.length !== (previousFailures?.length || 0)) {
    await saveFailedCachedImages(nextFailures)
  }
  await pruneCachedImages(validItemIds).catch((error) => {
    console.warn('[Almanax] shared image prune failed', error)
  })
  return new Map()
}

export async function checkAlmanaxDataStatus(data: AlmanaxData): Promise<DatabaseStatus> {
  const [itemPage, recipePage, itemSetPage] = await Promise.all([
    endpointInfo('/items'),
    endpointInfo('/recipes'),
    endpointInfo('/item-sets'),
  ])
  const sharedCatalog = await loadSharedCatalog<SharedCatalogData>().catch(() => null)
  const localItems = localRemoteMetadata(data, sharedCatalog, 'items')
  const localRecipes = localRemoteMetadata(data, sharedCatalog, 'recipes')
  const localItemSets = localRemoteMetadata(data, sharedCatalog, 'itemSets')

  const status = {
    remoteItemTotal: itemPage.total,
    localItemTotal: localItems.total,
    remoteRecipeTotal: recipePage.total,
    localRecipeTotal: localRecipes.total,
    remoteItemSetTotal: itemSetPage.total,
    localItemSetTotal: localItemSets.total,
  }
  const missingLabels: string[] = []
  if (status.remoteItemTotal !== status.localItemTotal || (itemPage.latestUpdatedAt && itemPage.latestUpdatedAt !== localItems.latestUpdatedAt)) missingLabels.push('items')
  if (status.remoteRecipeTotal !== status.localRecipeTotal || (recipePage.latestUpdatedAt && recipePage.latestUpdatedAt !== localRecipes.latestUpdatedAt)) missingLabels.push('recettes')
  if (status.remoteItemSetTotal !== status.localItemSetTotal || (itemSetPage.latestUpdatedAt && itemSetPage.latestUpdatedAt !== localItemSets.latestUpdatedAt)) missingLabels.push('panoplies')
  const cachedIds = new Set(await loadCachedImageIds())
  const ignoredImageIds = recentFailedImageIds(await loadFailedCachedImages())
  const missingImageGroups = groupMissingImages(data, new Set([...cachedIds, ...ignoredImageIds])).length
  if (missingImageGroups > 0) missingLabels.push('images')
  return { ...status, missingImageGroups, missingLabels, needsSync: missingLabels.length > 0 }
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
    image_path: item?.image_path || '',
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

  const mergeDeps = (target: Record<string, number>, source: Record<string, number>, skipItemId?: number) => {
    Object.entries(source).forEach(([itemId, quantity]) => {
      if (skipItemId != null && Number(itemId) === skipItemId) return
      target[itemId] = (target[itemId] || 0) + Number(quantity)
    })
  }

  function expand(itemId: number, quantity: number, depth = 0, stack = new Set<number>()): Record<string, number> {
    const item = data.items[String(itemId)]
    const recipe = data.recipes[String(itemId)]
    if (isRecipeExcluded(item)) {
      mergeQuantity(excluded, itemId, quantity)
      return { [String(itemId)]: quantity }
    }

    if (stack.has(itemId)) {
      mergeQuantity(obtainDirectly, itemId, quantity)
      return { [String(itemId)]: quantity }
    }

    if (!recipe) {
      mergeQuantity(depth === 0 ? obtainDirectly : ingredients, itemId, quantity)
      return { [String(itemId)]: quantity }
    }

    const isDirectCraft = depth === 0
    mergeQuantity(isDirectCraft ? directCrafts : subCrafts, itemId, quantity)
    const lineKey = `${isDirectCraft ? 'direct_crafts' : 'sub_crafts'}:${itemId}`
    dependencies[lineKey] ||= {}

    const nextStack = new Set(stack)
    nextStack.add(itemId)

    recipe.ingredient_ids.forEach((ingredientId, index) => {
      const needed = quantity * Number(recipe.quantities[index] || 1)
      dependencies[lineKey][String(ingredientId)] = (dependencies[lineKey][String(ingredientId)] || 0) + needed
      mergeDeps(dependencies[lineKey], expand(ingredientId, needed, depth + 1, nextStack), ingredientId)
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


