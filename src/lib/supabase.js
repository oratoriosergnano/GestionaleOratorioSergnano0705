// src/lib/supabase.js — VERSIONE CON STORAGE MULTI-CONTESTO
// Risolve conflitti tra tab admin e tab utente sullo stesso browser

import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.REACT_APP_SUPABASE_URL
const supabaseKey  = process.env.REACT_APP_SUPABASE_ANON_KEY

// ✅ SOLUZIONE: Storage con namespace per evitare conflitti tra tab
class NamespacedStorage {
  constructor(prefix = 'oratorio') {
    this.prefix = prefix
    // Usa localStorage per persistenza, ma con namespace per separare contesti
    this.storage = localStorage
  }

  getItem(key) {
    return this.storage.getItem(`${this.prefix}:${key}`)
  }

  setItem(key, value) {
    return this.storage.setItem(`${this.prefix}:${key}`, value)
  }

  removeItem(key) {
    return this.storage.removeItem(`${this.prefix}:${key}`)
  }

  clear() {
    // Pulisci solo le chiavi di questo namespace
    const keys = Object.keys(this.storage).filter(k => k.startsWith(`${this.prefix}:`))
    keys.forEach(k => this.storage.removeItem(k))
  }
}

// ✅ ISOLAMENTO: Crea storage separati per admin e utente
const adminStorage = new NamespacedStorage('oratorio:admin')
const userStorage = new NamespacedStorage('oratorio:user')

// Determina quale storage usare in base al contesto
const getContextStorage = () => {
  const path = window.location.pathname
  const isAdmin = window.location.hostname.startsWith('admin.') || 
                  path.includes('/admin') ||
                  window.location.search.includes('admin=true')
  return isAdmin ? adminStorage : userStorage
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken:    true,
    persistSession:      true,
    detectSessionInUrl:  true,
    storage:             getContextStorage(), // ✅ Storage dinamico basato sul contesto
    
    // ✅ Gestione migliore dei lock con retry
    storageOptions: {
      retry: {
        count: 3,
        delay: (attempt) => Math.pow(2, attempt) * 100,
      }
    },
  },
})

// ✅ PREVENZIONE: Monitora e ripulisce storage corrotto
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'STORAGE_ERROR') {
    console.error('Errore storage auth')
    const storage = getContextStorage()
    try {
      // Pulisci solo il namespace corrente, non tutto
      storage.clear()
      window.location.reload()
    } catch (e) {
      console.error('Errore nel cleanup:', e)
    }
  }
})

