// src/lib/supabase.js — VERSIONE AGGIORNATA con Auth e Sincronizzazione
// Gestione robusta delle race conditions e corruzione localStorage

import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.REACT_APP_SUPABASE_URL
const supabaseKey  = process.env.REACT_APP_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken:    true,
    persistSession:      true,
    detectSessionInUrl:  true,
    storage:             localStorage,
    
    // ✅ MIGLIORAMENTO: Gestione migliore dei lock
    // Usa timeout più alto e retry automatico
    storageOptions: {
      // Non disabilitare il lock — piuttosto usa retry con backoff
      retry: {
        count: 3,
        delay: (attempt) => Math.pow(2, attempt) * 100, // Backoff esponenziale: 100ms, 200ms, 400ms
      }
    },
  },
})

// ✅ PREVENZIONE: Interceptor per errori di lock
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'STORAGE_ERROR') {
    console.error('Errore storage auth — localStorage potrebbe essere corrotto')
    // Pulisci e forza refresh
    try {
      // Identifica quali chiavi sono corrotte
      const keys = Object.keys(localStorage).filter(k => k.startsWith('sb-'))
      keys.forEach(k => {
        try {
          JSON.parse(localStorage.getItem(k))
        } catch (e) {
          console.warn(`Rimuovendo chiave corrotta: ${k}`)
          localStorage.removeItem(k)
        }
      })
    } catch (e) {
      console.error('Errore nel cleanup:', e)
    }
  }
})

