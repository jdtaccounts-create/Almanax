import type { AlmanaxData, CachedItem } from './almanaxLogic'

const JOB_ORDER: Record<string, number> = {
  Bucheron: 10,
  Mineur: 20,
  Paysan: 30,
  Pecheur: 40,
  Alchimiste: 50,
  Chasseur: 60,
}

function harvestableRank(data: AlmanaxData, item: CachedItem): [number, number, string] {
  const harvestable = data.sortMetadata?.harvestables?.[String(item.id)]
  if (!harvestable) return [9, 9999, '']
  const rarityRank = harvestable.rarity === 'normal' ? 0 : harvestable.rarity === 'rare' ? 1 : 2
  const bucket = harvestable.rarity === 'rare' ? 1 : 0
  return [bucket, JOB_ORDER[harvestable.job] || 999, `${rarityRank}:${harvestable.order}`]
}

function originRank(data: AlmanaxData, item: CachedItem): [number, string, number] {
  const origin = data.sortMetadata?.resourceOrigins?.[String(item.id)]
  if (!origin?.origins.length) return [8, '', 9999]
  const first = origin.origins[0]
  return [1, first.race_name || first.super_race_name || first.monster_name, first.min_level || 9999]
}

function baseRank(data: AlmanaxData, item: CachedItem): string {
  const [harvestableBucket, jobOrder, harvestOrder] = harvestableRank(data, item)
  if (harvestableBucket < 9) return `${harvestableBucket}:${jobOrder}:${harvestOrder}`
  const [originBucket, originLabel, originLevel] = originRank(data, item)
  if (originBucket === 1) return `1:${originLabel}:${originLevel}`
  return `9:${item.type_name || item.raw_type || ''}`
}

export function compareItemIds(data: AlmanaxData, aId: number, bId: number): number {
  const a = data.items[String(aId)]
  const b = data.items[String(bId)]
  if (!a || !b) return aId - bId
  const rankA = baseRank(data, a)
  const rankB = baseRank(data, b)
  return rankA.localeCompare(rankB, 'fr')
    || (a.type_name || a.raw_type || '').localeCompare(b.type_name || b.raw_type || '', 'fr')
    || a.name.localeCompare(b.name, 'fr')
    || a.id - b.id
}
