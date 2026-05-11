/**
 * authSync.js — Gestione thread-safe dell'autenticazione
 * Risolve le race conditions tra getSession e onAuthStateChange
 */

class AuthLock {
  constructor() {
    this.locked = false
    this.queue = []
  }

  async acquire(fn) {
    while (this.locked) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    this.locked = true
    try {
      return await fn()
    } finally {
      this.locked = false
    }
  }
}

export const authLock = new AuthLock()

/**
 * Sincronizza l'autenticazione tra tab usando BroadcastChannel
 * Evita che più tab competano per il token
 */
export class AuthSync {
  constructor() {
    this.channel = null
    this.listeners = []
    this.lastSessionId = null
    
    try {
      this.channel = new BroadcastChannel('auth-sync')
      this.channel.onmessage = (event) => {
        const { type, payload } = event.data
        this.listeners.forEach(cb => cb(type, payload))
      }
    } catch (e) {
      console.warn('BroadcastChannel non supportato:', e.message)
    }
  }

  broadcast(type, payload) {
    if (this.channel) {
      this.channel.postMessage({ type, payload })
    }
  }

  subscribe(callback) {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback)
    }
  }

  destroy() {
    if (this.channel) {
      this.channel.close()
    }
    this.listeners = []
  }
}

export const authSync = new AuthSync()

/**
 * Debounce il caricamento della sessione
 * Evita che getSession() venga chiamato troppe volte
 */
export const debouncedGetSession = (() => {
  let timeoutId = null
  let lastResult = null
  let isLoading = false

  return async (supabase, delayMs = 300) => {
    return new Promise((resolve) => {
      if (timeoutId) clearTimeout(timeoutId)
      
      timeoutId = setTimeout(async () => {
        if (isLoading) {
          resolve(lastResult)
          return
        }
        
        isLoading = true
        try {
          const result = await supabase.auth.getSession()
          lastResult = result
          resolve(result)
        } catch (e) {
          console.error('Errore getSession:', e)
          resolve({ data: { session: null }, error: e })
        } finally {
          isLoading = false
        }
      }, delayMs)
    })
  }
})()

/**
 * Pulisce localStorage corrotto
 * Usato quando la navigazione corrompe i dati
 */
export const cleanupCorruptedAuth = () => {
  try {
    // Lista di chiavi Supabase che potrebbe corrompere
    const sbKeys = Object.keys(localStorage).filter(k => 
      k.startsWith('sb-') || 
      k.includes('session') ||
      k.includes('token')
    )
    
    sbKeys.forEach(key => {
      try {
        const value = localStorage.getItem(key)
        // Se il valore è incompleto o non è JSON valido, rimuovilo
        if (value) {
          JSON.parse(value)
        }
      } catch (e) {
        console.warn(`Chiave corrotta rimossa: ${key}`)
        localStorage.removeItem(key)
      }
    })
    
    return true
  } catch (e) {
    console.error('Errore cleanup:', e)
    return false
  }
}

/**
 * Monitor localStorage per cambiamenti corrotti
 */
export const monitorStorageIntegrity = () => {
  const checkInterval = setInterval(() => {
    try {
      const sbKeys = Object.keys(localStorage).filter(k => k.startsWith('sb-'))
      
      for (const key of sbKeys) {
        const value = localStorage.getItem(key)
        if (value && value.length > 1) {
          // Verifica che sia JSON valido
          JSON.parse(value)
        }
      }
    } catch (e) {
      console.error('Storage corrotto rilevato:', e)
      cleanupCorruptedAuth()
    }
  }, 5000) // Controlla ogni 5 secondi
  
  return () => clearInterval(checkInterval)
}
