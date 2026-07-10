import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(scriptDir, '..')
const dataDir = join(rootDir, 'public', 'data')
const publicDir = join(rootDir, 'public')
const imageDir = join(publicDir, 'cache', 'images')
const questPlannerRoot = join(rootDir, '..', 'QuestPlanner')
const questPlannerPublicDir = join(questPlannerRoot, 'public')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function isLocalPath(path) {
  return Boolean(path && !/^https?:\/\//.test(path))
}

const [items, questItems, metadata] = await Promise.all([
  readJson(join(dataDir, 'items.json')),
  readJson(join(questPlannerPublicDir, 'data', 'items.json')),
  readJson(join(dataDir, 'metadata.json')).catch(() => ({})),
])

await mkdir(imageDir, { recursive: true })

let copied = 0
const missing = []
const referencedImages = new Set()

for (const item of Object.values(items)) {
  const questItem = questItems[String(item.id)]
  const imagePath = isLocalPath(questItem?.image_path) ? questItem.image_path : ''
  if (!imagePath) {
    missing.push({ id: item.id, name: item.name, reason: 'missing local QuestPlanner path' })
    continue
  }

  const normalizedPath = imagePath.replace(/\\/g, '/')
  const source = join(questPlannerPublicDir, normalizedPath)
  const target = join(publicDir, normalizedPath)
  if (!existsSync(source)) {
    missing.push({ id: item.id, name: item.name, reason: `missing file ${normalizedPath}` })
    continue
  }

  await mkdir(dirname(target), { recursive: true })
  if (!existsSync(target)) {
    await copyFile(source, target)
    copied += 1
  }
  item.image_path = imagePath
  referencedImages.add(normalizedPath)
}

for (const name of await readdir(imageDir).catch(() => [])) {
  const normalizedPath = `cache/images/${name}`
  if (!referencedImages.has(normalizedPath)) await unlink(join(imageDir, name))
}

const nextMetadata = {
  ...metadata,
  offline_image_total: referencedImages.size,
  offline_image_source: 'DofusCompanionData shared image catalog',
  last_offline_image_sync: new Date().toISOString(),
}

await writeFile(join(dataDir, 'items.json'), JSON.stringify(items), 'utf8')
await writeFile(join(dataDir, 'metadata.json'), JSON.stringify(nextMetadata, null, 2), 'utf8')

if (missing.length) {
  console.error(JSON.stringify(missing.slice(0, 50), null, 2))
  throw new Error(`${missing.length} image(s) sans chemin local QuestPlanner`)
}

console.log(`Images Almanax OK : ${referencedImages.size} fichier(s) locaux, ${copied} copie(s) ajoutees`)
