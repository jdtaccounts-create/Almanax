import { chromium } from 'playwright-core'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const url = process.env.ALMANAX_URL || 'http://127.0.0.1:4175'
const browser = await chromium.launch({ executablePath: edgePath, headless: true })
const errors = []

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input.url
      if (!rawUrl.startsWith('https://api.dofusdb.fr')) return realFetch(input, init)
      const url = new URL(rawUrl)
      const path = url.pathname
      if (path === '/items' && url.searchParams.get('$limit') === '1') {
        return new Response(JSON.stringify({ total: 21567, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/recipes' && url.searchParams.get('$limit') === '1') {
        return new Response(JSON.stringify({ total: 4852, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/items') {
        return new Response(JSON.stringify({ total: 1, data: [{ id: 18665, name: { fr: 'Bouclier de Bowisse' }, type: { name: { fr: 'Bouclier' }, superType: { name: { fr: 'Bouclier' } } }, img: 'https://api.dofusdb.fr/img/items/82021.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/almanax') {
        return new Response(JSON.stringify({ itemIds: [18665], quantities: [1], dates: ['14/05/*'], name: { fr: 'Objets de qualité' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.body.innerText.includes('Almanax'))
  await page.waitForFunction(() => document.body.innerText.includes('Bouclier de Bowisse') || document.body.innerText.includes('offrandes'))
  await page.getByTitle(/Mode jour|Mode nuit/).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.locator('.craft-button').click()
  await page.waitForTimeout(300)
  const firstCraftBadge = (await page.locator('.craft-column header > span').first().textContent()) || ''
  if (!/^\d+\/\d+$/.test(firstCraftBadge.trim())) throw new Error(`Badge craft invalide : ${firstCraftBadge}`)
  const firstCraftCheckbox = page.locator('.craft-drawer.open .item-line input[type="checkbox"]').first()
  await firstCraftCheckbox.click()
  const checkedCraftCheckbox = page.locator('.craft-drawer.open .item-line.done input[type="checkbox"]').first()
  const checkedStyle = await checkedCraftCheckbox.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return { checked: element.checked, backgroundColor: style.backgroundColor, borderColor: style.borderColor }
  })
  if (!checkedStyle.checked || !checkedStyle.backgroundColor.includes('31, 179, 91')) {
    throw new Error(`Checkbox non remplie en mode clair : ${JSON.stringify(checkedStyle)}`)
  }
  await page.screenshot({ path: join(tmpdir(), 'almanax-smoke.png'), fullPage: false })
  if (errors.length) throw new Error(errors.join(' | '))
  console.log('Smoke OK')
} finally {
  await browser.close()
}

