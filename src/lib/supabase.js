// src/lib/supabase.js — VERSIONE AGGIORNATA con Auth
// Sostituisce il file esistente in src/lib/supabase.js

import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.REACT_APP_SUPABASE_URL
const supabaseKey  = process.env.REACT_APP_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken:    true,
    persistSession:      true,
    detectSessionInUrl:  true,
    storage:             localStorage,
  },
})
