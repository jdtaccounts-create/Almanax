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
      const isApiUrl = rawUrl.startsWith('https://api.dofusdb.fr')
        || rawUrl.startsWith('/dofusdb-api')
        || rawUrl.startsWith('https://api.dofusdu.de')
        || rawUrl.startsWith('/dofusdude-api')
      if (!isApiUrl) return realFetch(input, init)
      const url = new URL(rawUrl, window.location.origin)
      const path = url.pathname
        .replace(/^\/dofusdb-api/, '')
        .replace(/^\/dofusdude-api/, '')
      if (path.startsWith('/dofus3/v1/fr/almanax/')) {
        return new Response(JSON.stringify({
          date: '2026-05-14',
          tribute: {
            quantity: 1,
            item: {
              ankama_id: 18665,
              name: 'Bouclier de Bowisse',
              subtype: 'equipment',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/items' && url.searchParams.get('$limit') === '1') {
        return new Response(JSON.stringify({ total: 21567, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/recipes' && url.searchParams.get('$limit') === '1') {
        return new Response(JSON.stringify({ total: 4852, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/items') {
        return new Response(JSON.stringify({ total: 1, data: [{ id: 18665, name: { fr: 'Bouclier de Bowisse' }, type: { name: { fr: 'Bouclier' }, superType: { name: { fr: 'Bouclier' } } }, img: 'https://api.dofusdb.fr/img/items/82021.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('.workspace').waitFor()
  const defaultEndDate = await page.locator('.date-field input[type="date"]').nth(1).inputValue()
  const expectedMonthEnd = await page.evaluate(() => {
    const today = new Date()
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    const year = end.getFullYear()
    const month = String(end.getMonth() + 1).padStart(2, '0')
    const date = String(end.getDate()).padStart(2, '0')
    return `${year}-${month}-${date}`
  })
  if (defaultEndDate !== expectedMonthEnd) {
    throw new Error(`Fin de mois invalide : ${defaultEndDate}, attendu ${expectedMonthEnd}`)
  }
  await page.waitForFunction(() => document.body.innerText.includes('Bouclier de Bowisse') || document.body.innerText.includes('offrandes'))
  await page.getByTitle(/Mode jour|Mode nuit/).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.locator('.craft-rail').click()
  await page.waitForTimeout(300)
  const firstCraftBadge = (await page.locator('.craft-column header > span').first().textContent()) || ''
  if (!/^\d+\/\d+$/.test(firstCraftBadge.trim())) throw new Error(`Badge craft invalide : ${firstCraftBadge}`)
  const firstCraftCheckbox = page.locator('.craft-drawer.open .item-line input[type="checkbox"]').first()
  await firstCraftCheckbox.click()
  await page.waitForTimeout(100)
  const checkedStyle = await firstCraftCheckbox.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return { checked: element.checked, backgroundColor: style.backgroundColor, borderColor: style.borderColor }
  })
  const questPlannerGreen = checkedStyle.backgroundColor.includes('52, 199, 89')
  const previousGreen = checkedStyle.backgroundColor.includes('31, 179, 91')
  if (!checkedStyle.checked || (!questPlannerGreen && !previousGreen)) {
    throw new Error(`Checkbox non remplie en mode clair : ${JSON.stringify(checkedStyle)}`)
  }
  await page.screenshot({ path: join(tmpdir(), 'almanax-smoke.png'), fullPage: false })
  if (errors.length) throw new Error(errors.join(' | '))
  console.log('Smoke OK')
} finally {
  await browser.close()
}

