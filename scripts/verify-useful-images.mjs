import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(scriptDir, '..')
const publicDir = join(rootDir, 'public')
const dataDir = join(publicDir, 'data')
const imageDir = join(publicDir, 'cache', 'images')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const items = await readJson(join(dataDir, 'items.json'))
const missingImages = []
const remotePaths = []
const referencedImages = new Set()

for (const item of Object.values(items)) {
  const imagePath = String(item.image_path || '').replace(/\\/g, '/')
  if (!imagePath || /^https?:\/\//.test(imagePath)) {
    remotePaths.push({ id: item.id, name: item.name, image_path: item.image_path || '' })
    continue
  }
  referencedImages.add(imagePath)
  if (!existsSync(join(publicDir, imagePath))) {
    missingImages.push({ id: item.id, name: item.name, image_path: item.image_path })
  }
}

const orphanImages = (await readdir(imageDir).catch(() => []))
  .map((name) => `cache/images/${name}`)
  .filter((path) => !referencedImages.has(path))

if (missingImages.length || remotePaths.length || orphanImages.length) {
  console.error(JSON.stringify({
    missingImages: missingImages.slice(0, 50),
    remotePaths: remotePaths.slice(0, 50),
    orphanImages: orphanImages.slice(0, 50),
    counts: {
      missingImages: missingImages.length,
      remotePaths: remotePaths.length,
      orphanImages: orphanImages.length,
    },
  }, null, 2))
  process.exit(1)
}

console.log(`Images Almanax vérifiées : ${Object.keys(items).length} items, ${referencedImages.size} fichier(s) locaux`)
