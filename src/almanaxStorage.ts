import type { AlmanaxData } from './almanaxLogic'

const DB_NAME = 'almanax-quasar'
const DB_VERSION = 1
const STORE_NAME = 'json'
const DATA_KEY = 'almanax-data'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadStoredAlmanaxData(): Promise<AlmanaxData | null> {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(DATA_KEY)

    request.onsuccess = () => resolve((request.result as AlmanaxData | undefined) || null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export async function saveStoredAlmanaxData(data: AlmanaxData): Promise<void> {
  const database = await openDatabase()
  const snapshot = JSON.parse(JSON.stringify(data)) as AlmanaxData

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(snapshot, DATA_KEY)
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
  })
}
