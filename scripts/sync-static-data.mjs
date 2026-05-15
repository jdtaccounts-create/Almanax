import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const PAGE_CONCURRENCY = 6

const scriptDir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(scriptDir, '..', 'public', 'data')

async function apiGet(path, params = {}) {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const response = await fetch(url)
  if (!response.ok) throw new Error(`DofusDB ${response.status} ${response.statusText}`)
  return response.json()
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0

  async function runNext() {
    const index = cursor
    cursor += 1
    if (index >= items.length) return
    results[index] = await worker(items[index], index)
    await runNext()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()))
  return results
}

async function fetchPaginated(path, label) {
  const firstPage = await apiGet(path, { $limit: PAGE_LIMIT, $skip: 0 })
  const total = Number(firstPage.total || 0)
  const firstRows = firstPage.data || []
  const pageLimit = firstRows.length || PAGE_LIMIT
  const skips = []
  for (let skip = pageLimit; skip < total; skip += pageLimit) skips.push(skip)

  let loaded = firstRows.length
  console.log(`${label} ${loaded}/${total}`)

  const pages = await mapWithConcurrency(skips, PAGE_CONCURRENCY, async (skip) => {
    const page = await apiGet(path, { $limit: PAGE_LIMIT, $skip: skip })
    const rows = page.data || []
    loaded += rows.length
    if (loaded === total || loaded % 1000 < PAGE_LIMIT) console.log(`${label} ${Math.min(loaded, total)}/${total}`)
    return rows
  })

  const rows = firstRows.concat(...pages)
  if (rows.length !== total) throw new Error(`${label}: ${rows.length} lignes recues pour ${total} attendues`)
  return rows
}

function localText(raw, key, fallback) {
  return raw?.[key]?.fr || raw?.[key]?.en || fallback
}

function normalizeItemCategory(rawType) {
  if (rawType === 'Ressource' || rawType === 'Consommable') return rawType
  return 'Equipement'
}

function extractRawType(rawItem) {
  return rawItem?.type?.superType?.name?.fr || rawItem?.type?.name?.fr || rawItem?.superType?.name?.fr || 'Equipement'
}

function normalizeApiItem(rawItem) {
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

function normalizeRecipe(rawRecipe) {
  if (!rawRecipe || rawRecipe.resultId == null) return null
  return {
    result_id: Number(rawRecipe.resultId),
    ingredient_ids: (rawRecipe.ingredientIds || []).map(Number),
    quantities: (rawRecipe.quantities || []).map(Number),
  }
}

function idsChecksum(ids) {
  const sorted = Array.from(ids).map(String).sort().join('\n')
  let hash = 0
  for (let index = 0; index < sorted.length; index += 1) {
    hash = Math.imul(31, hash) + sorted.charCodeAt(index)
    hash |= 0
  }
  return String(hash >>> 0)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const [rawItems, rawRecipes] = await Promise.all([
  fetchPaginated('/items', 'Items'),
  fetchPaginated('/recipes', 'Recettes'),
])

const items = Object.fromEntries(
  rawItems
    .map(normalizeApiItem)
    .filter(Boolean)
    .sort((a, b) => a.id - b.id)
    .map((item) => [String(item.id), item]),
)

const recipes = Object.fromEntries(
  rawRecipes
    .map(normalizeRecipe)
    .filter(Boolean)
    .sort((a, b) => a.result_id - b.result_id)
    .map((recipe) => [String(recipe.result_id), recipe]),
)

const metadataPath = join(dataDir, 'metadata.json')
const previousMetadata = await readJson(metadataPath, {})
const metadata = {
  ...previousMetadata,
  item_total: Object.keys(items).length,
  recipe_total: Object.keys(recipes).length,
  item_ids_checksum: idsChecksum(Object.keys(items)),
  recipe_ids_checksum: idsChecksum(Object.keys(recipes)),
  last_static_sync: new Date().toISOString(),
}

await writeFile(join(dataDir, 'items.json'), JSON.stringify(items), 'utf8')
await writeFile(join(dataDir, 'recipes.json'), JSON.stringify(recipes), 'utf8')
await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')

console.log(`Cache statique OK : ${Object.keys(items).length} items, ${Object.keys(recipes).length} recettes`)
