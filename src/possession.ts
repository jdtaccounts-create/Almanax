import type { CraftLine } from './almanaxLogic'

export type OwnedQuantities = Record<number, number>

export function clampOwned(quantity: number, maximum: number): number {
  return Math.max(0, Math.min(Math.floor(Number(quantity) || 0), Math.max(0, Math.floor(maximum))))
}

export function setOwned(owned: OwnedQuantities, itemId: number, quantity: number, maximum: number): OwnedQuantities {
  const next = { ...owned }
  const safe = clampOwned(quantity, maximum)
  if (safe) next[itemId] = safe
  else delete next[itemId]
  return next
}

export function toggleOwned(owned: OwnedQuantities, itemId: number, maximum: number): OwnedQuantities {
  return setOwned(owned, itemId, (owned[itemId] || 0) >= maximum ? 0 : maximum, maximum)
}

export function allocateOwned(lines: CraftLine[], owned: OwnedQuantities): Record<string, number> {
  const consumed = new Map<number, number>()
  return Object.fromEntries(lines.map((line) => {
    const alreadyAllocated = consumed.get(line.item_id) || 0
    const allocation = Math.min(Math.max((owned[line.item_id] || 0) - alreadyAllocated, 0), line.quantity)
    consumed.set(line.item_id, alreadyAllocated + allocation)
    return [line.line_key, allocation]
  }))
}

export function setCraftLineComplete(
  owned: OwnedQuantities,
  lines: CraftLine[],
  lineKey: string,
  complete: boolean,
): OwnedQuantities {
  const line = lines.find((candidate) => candidate.line_key === lineKey)
  if (!line) return owned
  const sameItemLines = lines.filter((candidate) => candidate.item_id === line.item_id)
  const lineIndex = sameItemLines.findIndex((candidate) => candidate.line_key === lineKey)
  const prefixMaximum = sameItemLines.slice(0, lineIndex + 1).reduce((total, candidate) => total + candidate.quantity, 0)
  const beforeMaximum = prefixMaximum - line.quantity
  const totalMaximum = sameItemLines.reduce((total, candidate) => total + candidate.quantity, 0)
  return setOwned(owned, line.item_id, complete ? Math.max(owned[line.item_id] || 0, prefixMaximum) : Math.min(owned[line.item_id] || 0, beforeMaximum), totalMaximum)
}

export function setCraftLineAllocation(
  owned: OwnedQuantities,
  lines: CraftLine[],
  lineKey: string,
  allocation: number,
): OwnedQuantities {
  const line = lines.find((candidate) => candidate.line_key === lineKey)
  if (!line) return owned
  const sameItemLines = lines.filter((candidate) => candidate.item_id === line.item_id)
  const lineIndex = sameItemLines.findIndex((candidate) => candidate.line_key === lineKey)
  const beforeMaximum = sameItemLines.slice(0, lineIndex).reduce((total, candidate) => total + candidate.quantity, 0)
  const totalMaximum = sameItemLines.reduce((total, candidate) => total + candidate.quantity, 0)
  const currentAllocation = allocateOwned(lines, owned)[lineKey] || 0
  const desiredAllocation = clampOwned(allocation, line.quantity)
  const adjustedTotal = (owned[line.item_id] || 0) + desiredAllocation - currentAllocation
  const nextTotal = desiredAllocation > currentAllocation
    ? Math.max(adjustedTotal, beforeMaximum + desiredAllocation)
    : Math.min(adjustedTotal, beforeMaximum + desiredAllocation)
  return setOwned(owned, line.item_id, nextTotal, totalMaximum)
}
