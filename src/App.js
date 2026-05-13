import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from './lib/supabase'
import { authLock, authSync, monitorStorageIntegrity, cleanupCorruptedAuth } from './lib/authSync'
import './styles.css'

// ─── COSTANTI ─────────────────────────────────────────────────────────────────
const RUOLI = {
  superadmin:        { label: 'Super Admin',        color: '#c0392b' },
  admin_eventi:      { label: 'Admin Eventi',        color: '#2980b9' },
  admin_campetto:    { label: 'Admin Campetto',      color: 'var(--green)' },
  admin_sala:        { label: 'Admin Sala Feste',    color: '#8e44ad' },
  admin_feste:       { label: 'Admin Feste',         color: '#e67e22' },
  admin_appartamento:{ label: 'Admin Appartamento',  color: '#d35400' },
  admin_segreteria:  { label: 'Segreteria',          color: '#7f8c8d' },
}

// AULE_COLORS palette — usata dinamicamente per le aule configurate dall'admin
const PALETTE_COLORS = ['#e74c3c','#3498db','#27ae60','#8e44ad','#d35400','#16a085','#c0392b','#1abc9c','#e67e22','#2c3e50']

const canManage = (ruolo, sezione) => {
  if (ruolo === 'superadmin') return true

  // Raccoglie tutti i permessi del ruolo (fissi o custom)
  let permessi = []
  const mapFissi = {
    admin_eventi:       ['eventi'],
    admin_campetto:     ['campetto'],
    admin_sala:         ['sala'],
    admin_feste:        ['feste'],
    admin_appartamento: ['appartamento'],
    admin_segreteria:   ['eventi','feste'],
  }
  if (mapFissi[ruolo]) {
    permessi = mapFissi[ruolo]
  } else {
    try {
      const ruoliCustom = JSON.parse(localStorage.getItem('oratorio_ruoli_custom') || '[]')
      const ruoloObj = ruoliCustom.find(r => r.id === ruolo)
      permessi = ruoloObj?.permessi || []
    } catch {}
  }

  // Permesso esatto
  if (permessi.includes(sezione)) return true

  // Sezione principale richiesta (es. 'eventi'): true se ha anche solo una sotto-sezione
  if (!sezione.includes('.')) {
    if (permessi.some(p => p === sezione || p.startsWith(sezione + '.'))) return true
    return false
  }

  // Sotto-sezione richiesta (es. 'eventi.appello'): true se ha il permesso esatto o la sezione intera
  const [sezPrincipale] = sezione.split('.')
  if (permessi.includes(sezPrincipale)) return true
  return false
}

// Carica e salva i ruoli custom in localStorage (chiamato una volta all'avvio dell'admin)
// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
// Registra ogni azione admin nella tabella audit_log
const logAudit = async ({ user, azione, categoria, dettaglio, meta = {}, esito = 'ok' }) => {
  try {
    await supabase.from('audit_log').insert([{
      admin_id:    user?.id    || null,
      admin_nome:  user?.nome  || 'Sconosciuto',
      admin_email: user?.email || '',
      azione,
      categoria,
      dettaglio,
      meta,
      esito,
    }])
  } catch (e) {
    // Il log non deve mai bloccare l'app
    console.warn('audit log error', e)
  }
}

const aggiornaRuoliCustomLS = async () => {
  try {
    const { data } = await supabase.from('configurazioni').select('valore').eq('id','ruoli_custom').maybeSingle()
    localStorage.setItem('oratorio_ruoli_custom', JSON.stringify(data?.valore?.ruoli || []))
  } catch {}
}

const fmt   = (n) => `€${Number(n || 0).toFixed(2)}`
const today = () => new Date().toISOString().split('T')[0]
const uid   = () => crypto.randomUUID()
// Codice accesso genitore: 8 caratteri leggibili (no 0/O/1/I per evitare confusione)
const genCodice = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// Hash SHA-256 lato browser (per password genitori — non visibili agli admin)
const hashPassword = async (pwd) => {
  const enc = new TextEncoder().encode(pwd)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── WEB PUSH VAPID ──────────────────────────────────────────────────────────
// Chiave pubblica VAPID generata per questo progetto
const VAPID_PUBLIC_KEY = 'BB6AZ9spd84OOC9a1jFwt8kXIWcovqzNJCKNuy6Knlh2mdSsj291az7JtHKb8s8W-Ki927aIH7HDhDGzVO4ijFo'

// Converte base64url in Uint8Array (necessario per pushManager.subscribe)
const urlBase64ToUint8Array = (base64String) => {
  const pad = base64String.length % 4
  const b64 = (pad ? base64String + '='.repeat(4 - pad) : base64String)
    .replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// Salva subscription su Supabase
const salvaPushSubscription = async (userId, userType, subscription) => {
  try {
    const subStr = JSON.stringify(subscription)
    const userIdStr = String(userId) // assicura che sia stringa

    // Prima cerca per user_id
    const { data: existing, error: selErr } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', userIdStr)
      .maybeSingle()

    if (selErr) {
      console.warn('Errore select push_subscriptions:', selErr.message)
    }

    if (existing) {
      const { error: updErr } = await supabase.from('push_subscriptions')
        .update({ user_type: userType, subscription: subStr, updated_at: new Date().toISOString() })
        .eq('user_id', userIdStr)
      if (updErr) console.warn('Errore update push_sub:', updErr.message)
      else console.log('✅ Push subscription aggiornata per', userType, userIdStr.slice(0,8))
    } else {
      const { error: insErr } = await supabase.from('push_subscriptions')
        .insert([{ user_id: userIdStr, user_type: userType, subscription: subStr }])
      if (insErr) console.warn('Errore insert push_sub:', insErr.message)
      else console.log('✅ Push subscription salvata per', userType, userIdStr.slice(0,8))
    }
  } catch (e) {
    console.warn('Errore salvaPushSubscription:', e.message)
  }
}

// Chiede il permesso e registra il dispositivo
const initWebPush = async (userId, userType) => {
  // Controlla supporto base
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push non supportato su questo browser/dispositivo')
    return null
  }

  // Se non abbiamo un ID utente (es. utente non loggato), usiamo un ID del browser persistente
  // Questo permette di inviare notifiche "all" anche a chi non ha effettuato l'accesso
  let finalUserId = userId
  if (!finalUserId) {
    finalUserId = localStorage.getItem('oratorio_browser_id')
    if (!finalUserId) {
      finalUserId = 'browser_' + Math.random().toString(36).slice(2, 11)
      localStorage.setItem('oratorio_browser_id', finalUserId)
    }
  }
  const finalUserType = userType || 'anonimo'

  try {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    
    if (!sub) {
      // Chiedi permesso se non ce l'abbiamo (Notification.requestPermission è async)
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission()
        if (perm !== 'granted') return null
      } else if (Notification.permission === 'denied') {
        return null
      }

      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }

    await salvaPushSubscription(finalUserId, finalUserType, sub)
    return sub
  } catch (e) {
    console.warn('Web Push init error:', e.message)
    return null
  }
}

// Invia notifica tramite Edge Function (funziona in background)
const sendPushNotification = async ({ titolo, corpo, url = '/', target_tipo = 'superadmin', target_ids = null }) => {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY
    const supaUrl = process.env.REACT_APP_SUPABASE_URL
    await fetch(`${supaUrl}/functions/v1/send-push`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${anonKey}`,
        'apikey':         anonKey,
      },
      body: JSON.stringify({ titolo, corpo, url, target_tipo, target_ids }),
    })
  } catch (e) { console.warn('sendPushNotification error:', e) }
}

// Mostra notifica locale immediata (fallback quando l'app è aperta)
const mostraNotificaLocale = (titolo, corpo) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  navigator.serviceWorker?.ready.then(reg => {
    reg.showNotification(titolo, {
      body: corpo, icon: '/logo-oratorio.png', badge: '/logo-oratorio.png',
      vibrate: [200, 100, 200], tag: 'oratorio-' + Date.now(),
    })
  }).catch(() => {})
}

// Compatibilità con vecchio codice
const initOneSignal     = () => {}
const subscribeOneSignal = async () => null


// ─── TIPI DI CAMPO EXTRA ──────────────────────────────────────────────────────
const TIPI_CAMPO = [
  { id: 'testo',    label: 'Testo libero'  },
  { id: 'cf',       label: 'Codice Fiscale' },
  { id: 'numero',   label: 'Numero'         },
  { id: 'data',     label: 'Data'           },
  { id: 'email',    label: 'Email'          },
  { id: 'telefono', label: 'Telefono'       },
  { id: 'select',   label: 'Menu a scelta'  },
  { id: 'checkbox', label: 'Sì / No'        },
]

// Componente che renderizza un campo extra nel form pubblico
function CampoExtra({ campo, value, onChange }) {
  if (campo.tipo === 'select') {
    const opzioni = (campo.opzioni || '').split('\n').map(o => o.trim()).filter(Boolean)
    return (
      <div className="form-group">
        <label className="form-label">{campo.label}{campo.obbligatorio && ' *'}</label>
        <select className="form-select" value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— Seleziona —</option>
          {opzioni.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }
  if (campo.tipo === 'checkbox') {
    return (
      <div className="form-group">
        <label className={`check-item ${value ? 'checked' : ''}`}>
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
          <span>{campo.label}{campo.obbligatorio && ' *'}</span>
        </label>
      </div>
    )
  }
  const typeMap = { testo: 'text', cf: 'text', numero: 'number', data: 'date', email: 'email', telefono: 'tel' }
  return (
    <div className="form-group">
      <label className="form-label">{campo.label}{campo.obbligatorio && ' *'}</label>
      <input
        className="form-input"
        type={typeMap[campo.tipo] || 'text'}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={campo.tipo === 'cf' ? 'es. RSSMRA80A01H501T' : ''}
        style={campo.tipo === 'cf' ? { textTransform: 'uppercase', letterSpacing: 1 } : {}}
      />
    </div>
  )
}

// Editor campi extra — riutilizzabile in Crea/Modifica evento e config spazi
function EditorCampiExtra({ campi, onChange }) {
  const aggiungi = (tipo) => onChange([...campi, { id: uid(), tipo: tipo.id, label: tipo.id === 'cf' ? 'Codice Fiscale' : '', obbligatorio: false, opzioni: '' }])
  const aggiorna = (i, patch) => onChange(campi.map((c, j) => j === i ? { ...c, ...patch } : c))
  const rimuovi  = (i) => onChange(campi.filter((_, j) => j !== i))
  return (
    <div>
      {campi.map((c, i) => (
        <div key={c.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8, alignItems: 'end' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ fontSize: '.78rem' }}>Etichetta</label>
              <input className="form-input" value={c.label} placeholder="es. Classe scolastica" onChange={e => aggiorna(i, { label: e.target.value })} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ fontSize: '.78rem' }}>Tipo</label>
              <select className="form-select" value={c.tipo} onChange={e => aggiorna(i, { tipo: e.target.value })}>
                {TIPI_CAMPO.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <button className="btn btn-sm btn-danger" onClick={() => rimuovi(i)}>✕</button>
          </div>
          {c.tipo === 'select' && (
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label" style={{ fontSize: '.78rem' }}>Opzioni (una per riga)</label>
              <textarea className="form-textarea" style={{ minHeight: 80 }}
                placeholder="1 elementare&#10;2 elementare&#10;1 media&#10;2 media"
                value={c.opzioni || ''}
                onChange={e => aggiorna(i, { opzioni: e.target.value })} />
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.85rem', cursor: 'pointer', marginTop: 6 }}>
            <input type="checkbox" checked={!!c.obbligatorio} onChange={e => aggiorna(i, { obbligatorio: e.target.checked })} />
            Campo obbligatorio
          </label>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: '.8rem', color: 'var(--text-muted)', alignSelf: 'center', marginRight: 4 }}>+ Aggiungi:</span>
        {TIPI_CAMPO.map(t => (
          <button key={t.id} className="btn btn-sm btn-ghost" onClick={() => aggiungi(t)}>{t.label}</button>
        ))}
      </div>
    </div>
  )
}

function getDaysInRange(start, end) {
  const days = []; let d = new Date(start); const e = new Date(end)
  while (d <= e) { days.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 1) }
  return days
}

function getWeeksInRange(start, end) {
  const weeks = []; let d = new Date(start); const e = new Date(end); let wn = 1
  while (d <= e) {
    const wStart = new Date(d); const wEnd = new Date(d); wEnd.setDate(wEnd.getDate() + 6)
    if (wEnd > e) wEnd.setTime(e.getTime())
    weeks.push({
      id: String(wn),
      label: `Settimana ${wn} (${wStart.toLocaleDateString('it')} – ${wEnd.toLocaleDateString('it')})`,
      start: wStart.toISOString().split('T')[0],
      end:   wEnd.toISOString().split('T')[0],
    })
    d.setDate(d.getDate() + 7); wn++
  }
  return weeks
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
// ─── LOADING ──────────────────────────────────────────────────────────────────
function LoadingPage({ text = 'Caricamento...' }) {
  return (
    <div className="loading-page">
      <div className="spinner" />
      <p style={{ fontWeight: 700, color: 'var(--text-muted)' }}>{text}</p>
    </div>
  )
}

// ─── HOOK DATI SUPABASE ───────────────────────────────────────────────────────
function useSupabaseData(table, options = {}) {
  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    // Timeout di 5 secondi per le query
    const queryPromise = (async () => {
      let q = supabase.from(table).select(options.select || '*')
      if (options.eq) Object.entries(options.eq).forEach(([k, v]) => { q = q.eq(k, v) })
      if (options.order) q = q.order(options.order, { ascending: options.asc ?? false })
      if (options.limit) q = q.limit(options.limit)
      return await q
    })()

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout caricamento tabella ${table}`)), 5000)
    )

    try {
      const { data: result, error: err } = await Promise.race([queryPromise, timeoutPromise])
      if (err) {
        console.warn(`Errore caricamento ${table}:`, err.message)
        setError(err.message)
      } else {
        setData(result || [])
      }
    } catch (e) {
      console.error(`Catch caricamento ${table}:`, e.message)
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [table, JSON.stringify(options)]) // eslint-disable-line

  useEffect(() => {
    let isMounted = true
    if (isMounted) load()
    return () => { isMounted = false }
  }, [load])

  return { data, loading, error, reload: load }
}

// ─── RATE LIMITING LOGIN ─────────────────────────────────────────────────────
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_BLOCK_MS     = 15 * 60 * 1000  // 15 minuti

const getRateLimit = () => {
  try { return JSON.parse(localStorage.getItem('login_rate') || '{}') } catch { return {} }
}
const setRateLimit = (data) => localStorage.setItem('login_rate', JSON.stringify(data))
const isBlocked = () => {
  const r = getRateLimit()
  if (!r.blockedUntil) return false
  if (Date.now() < r.blockedUntil) return true
  // blocco scaduto — reset
  setRateLimit({})
  return false
}
const getAttemptsLeft = () => {
  const r = getRateLimit()
  return LOGIN_MAX_ATTEMPTS - (r.attempts || 0)
}
const recordFailedAttempt = () => {
  const r = getRateLimit()
  const attempts = (r.attempts || 0) + 1
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    setRateLimit({ attempts, blockedUntil: Date.now() + LOGIN_BLOCK_MS })
  } else {
    setRateLimit({ attempts })
  }
}
const resetRateLimit = () => setRateLimit({})

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
// ARCHITETTURA:
//   - Home pubblica: visibile a tutti, nessun login
//   - Moduli prenotazione/iscrizione: visibili a tutti, nessun login
//   - Area admin: richiede email + password
//
// FIX LOGIN: currentUser è uno state React separato (non dentro Supabase store)
// così setCurrentUser() e setView() vengono raggruppati nello stesso render.
export default function App() {
  const [currentUser,  setCurrentUser]  = useState(null)   // admin
  const [authUser,     setAuthUser]     = useState(null)   // utente pubblico Auth
  const [profilo,      setProfilo]      = useState(null)   // dati profilo
  const [loading,      setLoading]      = useState(true)
  const [loadingError, setLoadingError] = useState(null)   // nuovo: per gestire errori di caricamento
  const [view,         setView]         = useState({ type: 'home' })

  // Determinazione del dominio (Admin vs Pubblico)
  const isAdminDomain = window.location.hostname.startsWith('admin.') || window.location.search.includes('admin=true');

  // PWA: registra service worker con rilevamento aggiornamenti
  const [swUpdate, setSwUpdate] = useState(false)

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // Controlla aggiornamenti ogni 60 secondi
        setInterval(() => reg.update(), 60000)
        // Se c'è un nuovo SW in attesa, mostra il banner
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing
          if (!newSW) return
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              setSwUpdate(true)
            }
          })
        })
      }).catch(() => {})

      // NON ricarichiamo automaticamente — mostriamo solo il banner
      // (il reload automatico causa loop per chi fa deploy frequenti)
    }
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
    meta.content = '#E25B45'

    // Prova a inizializzare il Web Push per tutti (permette notifiche target "all")
    // Se il permesso è già concesso, aggiorna la sottoscrizione nel DB
    if ('Notification' in window && Notification.permission === 'granted') {
      initWebPush(null, 'anonimo')
    }
  }, [])

  const applicaAggiornamento = () => {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      }
    })
    setSwUpdate(false)
  }

  // Mostra errore visibile se mancano le credenziali Supabase
  const missingEnv = !process.env.REACT_APP_SUPABASE_URL || !process.env.REACT_APP_SUPABASE_ANON_KEY

  // ── Carica profilo utente Auth ────────────────────────────────────
  const caricaProfilo = async (userId) => {
    if (!userId) return null
    try {
      const { data, error } = await supabase.from('profili').select('*').eq('id', userId).maybeSingle()
      if (error) {
        console.error('Errore caricaProfilo:', error.message)
        return null
      }
      
      if (!data) {
        // Profilo non trovato, proviamo a crearlo se abbiamo un utente auth
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const nuovo = {
            id: user.id,
            nome: user.user_metadata?.nome || '',
            cognome: user.user_metadata?.cognome || '',
            telefono: null
          }
          const { data: created, error: insErr } = await supabase.from('profili').upsert(nuovo).select().single()
          if (insErr) {
            console.error('Errore creazione profilo:', insErr.message)
            return null
          }
          if (created) setProfilo(created)
          return created
        }
      }
      
      if (data) setProfilo(data)
      return data
    } catch (e) {
      console.error('Catch caricaProfilo:', e)
      return null
    }
  }

  // Funzione per pulire dati corrotti e riavviare
  const resetApp = () => {
    localStorage.clear()
    sessionStorage.clear()
    window.location.reload()
  }

  // ── Inizializzazione sessioni (CON THREAD-SAFETY) ────────────────────────────
  useEffect(() => {
    let isMounted = true
    let timeoutId = null
    let cleanupMonitor = null

    const init = async () => {
      try {
        // Timeout di sicurezza: dopo 10 secondi, mostra errore invece di bloccare
        timeoutId = setTimeout(() => {
          if (isMounted && loading) {
            console.warn('Timeout caricamento: attivo recovery')
            setLoadingError('timeout')
            setLoading(false)
          }
        }, 10000)

        // ✅ PROTEZIONE: Usa authLock per evitare race conditions
        await authLock.acquire(async () => {
          // 1. Sessione Supabase Auth (Sistema Unificato)
          const { data: { session } } = await supabase.auth.getSession()
          
          if (session?.user && isMounted) {
            // Controlliamo prima se l'utente è un AMMINISTRATORE
            const { data: adminProfile } = await supabase
              .from('admins')
              .select('*')
              .eq('id', session.user.id)
              .eq('attivo', true)
              .maybeSingle()

            if (adminProfile) {
              // È un admin autenticato
              setCurrentUser(adminProfile)
              setView({ type: 'admin' })
            } else {
              // È un utente genitore/pubblico
              setAuthUser(session.user)
              await caricaProfilo(session.user.id)
            }
          } else if (isMounted) {
            // Nessuna sessione attiva
            if (isAdminDomain) {
              setView({ type: 'admin-login' })
            } else {
              const params = new URLSearchParams(window.location.search)
              const resetToken = params.get('reset')
              if (resetToken) setView({ type: 'genitore', resetToken })
              const typeParam = params.get('type')
              if (typeParam === 'recovery') setView({ type: 'area-personale' })
            }
          }
        })
      } catch (e) {
        console.error('Errore init app:', e)
        // Se localStorage è corrotto, pulisci e ricarica
        if (e.message?.includes('lock') || e.message?.includes('storage')) {
          cleanupCorruptedAuth()
        }
        if (isMounted) {
          setLoadingError('error')
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        if (isMounted) setLoading(false)
      }
    }
    
    init()
    
    // ✅ MONITOR: Monitora corruzione localStorage durante navigazione
    cleanupMonitor = monitorStorageIntegrity()
    
    // ✅ SINCRONIZZAZIONE: Ascolta cambiamenti da altre tab
    const unsubscribeAuthSync = authSync.subscribe((type, payload) => {
      if (type === 'auth-change' && isMounted) {
        console.log('Auth sincronizzato da altra tab:', type)
      }
    })
    
    // ✅ MULTI-TAB SYNC: Ascolta cambiamenti localStorage da altre tab
    const handleStorageChange = (event) => {
      if (!isMounted) return
      
      // Se il token è cambiato da un'altra tab, ricarica la sessione
      if (event.key?.includes('sb-') || event.key?.includes('auth')) {
        console.log('Storage modificato da altra tab — sincronizzazione in corso...')
        // Ricarica la sessione corrente
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (isMounted) {
            if (!session && (currentUser || authUser)) {
              // Session persa — disconnetto
              console.warn('Session persa da altra tab — disconnessione')
              setCurrentUser(null)
              setAuthUser(null)
              setProfilo(null)
              setView({ type: 'home' })
            } else if (session && !currentUser && !authUser) {
              // Nuova session da altra tab — ricarico
              console.log('Nuova session rilevata da altra tab')
              init()
            }
          }
        })
      }
    }
    window.addEventListener('storage', handleStorageChange)
    
    // Ascolta cambiamenti sessione Auth (Login/Logout in tempo reale)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isMounted) return
      
      // ✅ BROADCAST: Comunica alle altre tab
      authSync.broadcast('auth-change', { event, session: session?.user?.id })
      
      // ✅ LOCK: Proteggi l'accesso concorrente
      await authLock.acquire(async () => {
        if (event === 'SIGNED_IN' && session?.user) {
          // Verifica se l'utente loggato è un admin
          const { data: adminProfile } = await supabase
            .from('admins')
            .select('*')
            .eq('id', session.user.id)
            .eq('attivo', true)
            .maybeSingle()

          if (adminProfile) {
            setCurrentUser(adminProfile)
            setView({ type: 'admin' })
          } else {
            setAuthUser(session.user)
            await caricaProfilo(session.user.id)
          }
        } else if (event === 'SIGNED_OUT') {
          setCurrentUser(null)
          setAuthUser(null)
          setProfilo(null)
          setView({ type: 'home' })
        }
      })
    })

    return () => {
      isMounted = false
      if (timeoutId) clearTimeout(timeoutId)
      if (cleanupMonitor) cleanupMonitor()
      unsubscribeAuthSync()
      window.removeEventListener('storage', handleStorageChange)
      subscription?.unsubscribe()
    }
  }, []) // eslint-disable-line

  // ── Auth pubblico: login, registrazione, logout ───────────────────
  const handleLoginUtente = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return error.message.includes('Invalid login credentials')
      ? 'Email o password non corretti.' : error.message
    return null
  }

  const handleRegistrazione = async ({ nome, cognome, email, password, telefono }) => {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { nome, cognome } },
    })
    if (error) return error.message.includes('already registered')
      ? 'Email già registrata. Prova ad accedere.' : error.message

    // Inserisce il profilo manualmente (fallback se il trigger DB non funziona)
    if (data?.user?.id) {
      await supabase.from('profili').upsert({
        id:       data.user.id,
        nome:     nome.trim(),
        cognome:  cognome.trim(),
        telefono: telefono?.trim() || null,
      }, { onConflict: 'id' })
    }
    return null
  }

  const handleLogoutUtente = async () => {
    await supabase.auth.signOut()
  }

  // Login ADMIN: utilizza il sistema basato su tabella (vecchio metodo)
  const handleLogin = async (email, password) => {
    const cleanEmail = (email || '').toLowerCase().trim()
    const cleanPass  = (password || '').trim()

    if (isBlocked()) {
      const r = getRateLimit()
      const min = Math.ceil((r.blockedUntil - Date.now()) / 60000)
      return `Troppi tentativi falliti. Riprova tra ${min} minuti.`
    }

    // 1. Cerca l'admin direttamente nella tabella 'admins' tramite email e password
    const { data: adminProfile, error: profileError } = await supabase
      .from('admins')
      .select('*')
      .eq('email', cleanEmail)
      .eq('password', cleanPass)
      .eq('attivo', true)
      .maybeSingle()

    if (profileError || !adminProfile) {
      recordFailedAttempt()
      return "Credenziali non valide o accesso negato."
    }

    resetRateLimit()
    setCurrentUser(adminProfile)
    setView({ type: 'admin' })
    await logAudit({ user: adminProfile, azione: 'LOGIN', categoria: 'Auth', dettaglio: `Accesso admin effettuato da ${adminProfile.nome}` })
    
    return null
  }

  const handleLogout = async () => {
    if (currentUser) {
      await logAudit({ user: currentUser, azione: 'LOGOUT', categoria: 'Auth', dettaglio: `${currentUser.nome} ha effettuato il logout` })
    }
    setCurrentUser(null)
    setView({ type: 'home' })
  }

  const goPublic = (type, id, extra) => setView(id ? { type, id, ...extra } : { type })
  const goHome   = () => setView({ type: 'home' })

  // Listener per redirect dai form pubblici
  useEffect(() => {
    const h1 = () => setView({ type: 'area-personale' })
    const h2 = () => setView({ type: 'login-utente' })
    const h3 = () => setView({ type: 'registrazione' })
    window.addEventListener('goto-area-personale', h1)
    window.addEventListener('goto-login-utente',   h2)
    window.addEventListener('goto-registrazione',  h3)
    return () => {
      window.removeEventListener('goto-area-personale', h1)
      window.removeEventListener('goto-login-utente',   h2)
      window.removeEventListener('goto-registrazione',  h3)
    }
  }, [])

  if (missingEnv) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff8e1', padding: 24 }}>
      <div style={{ maxWidth: 560, background: '#fff', borderRadius: 16, padding: 40, boxShadow: '0 4px 24px rgba(0,0,0,.12)', border: '2px solid #f5a623' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 16 }}>⚙️</div>
          <h2 style={{ color: '#e65100', marginBottom: 12, fontFamily: 'Nunito,sans-serif' }}>Configurazione mancante</h2>
          <p style={{ color: '#555', marginBottom: 20, lineHeight: 1.6 }}>
            L'app non riesce a connettersi al database perché mancano le variabili d'ambiente Supabase.
          </p>
          <div style={{ background: '#f5f5f5', borderRadius: 10, padding: '16px 20px', fontFamily: 'monospace', fontSize: '.9rem', marginBottom: 20 }}>
            <div style={{ color: '#666', marginBottom: 8, fontSize: '.8rem', fontFamily: 'sans-serif' }}>
              📄 Crea il file <b>.env</b> nella cartella del progetto:
            </div>
            <div style={{ color: '#1a6b3a' }}>REACT_APP_SUPABASE_URL=https://xxxxxxxx.supabase.co</div>
            <div style={{ color: '#1a6b3a' }}>REACT_APP_SUPABASE_ANON_KEY=eyJ...</div>
          </div>
          <p style={{ color: '#888', fontSize: '.85rem', lineHeight: 1.6 }}>
            Trovi i valori su <b>supabase.com</b> → il tuo progetto → <b>Settings → API</b>.<br/>
            Dopo aver creato il file <b>.env</b>, riavvia l'app con <code>npm start</code>.
          </p>
        </div>
      </div>
  )

  if (loading) return <LoadingPage text="Avvio gestionale..." />

  if (loadingError) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f2ee', padding: 24, fontFamily: "'Nunito', sans-serif" }}>
      <div style={{ maxWidth: 500, background: '#fff', borderRadius: 16, padding: 40, boxShadow: '0 4px 24px rgba(0,0,0,.12)', textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: 20 }}>⚠️</div>
        <h2 style={{ color: '#E25B45', marginBottom: 12 }}>Qualcosa è andato storto</h2>
        <p style={{ color: '#666', marginBottom: 30, lineHeight: 1.6 }}>
          Si è verificato un problema durante il caricamento. Questo di solito succede se i dati di navigazione sono corrotti.
        </p>
        <button 
          onClick={resetApp}
          style={{
            background: '#E25B45',
            color: 'white',
            border: 'none',
            borderRadius: 12,
            padding: '14px 32px',
            fontSize: '1.1rem',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(226, 91, 69, 0.3)'
          }}
        >
          🔄 Riavvia l'app
        </button>
        <p style={{ color: '#aaa', marginTop: 20, fontSize: '0.9rem' }}>
          Questo pulirà i dati temporanei e ricaricherà la pagina.
        </p>
      </div>
    </div>
  )

  return (
    <>
      {/* Banner aggiornamento SW disponibile */}
      {swUpdate && (
        <div style={{
          position:'fixed', bottom:20, left:'50%', transform:'translateX(-50%)',
          zIndex:99999, background:'#2d2420', color:'#fff',
          borderRadius:14, padding:'12px 20px',
          display:'flex', alignItems:'center', gap:14,
          boxShadow:'0 8px 32px rgba(0,0,0,.35)',
          maxWidth:380, width:'calc(100% - 32px)',
        }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, fontSize:'.88rem', marginBottom:2 }}>
              🆕 Aggiornamento disponibile
            </div>
            <div style={{ fontSize:'.75rem', opacity:.75 }}>
              È pronta una nuova versione dell'app
            </div>
          </div>
          <button onClick={applicaAggiornamento}
            style={{ background:'var(--primary)', border:'none', borderRadius:8,
              color:'#fff', fontWeight:700, fontSize:'.82rem',
              padding:'7px 14px', cursor:'pointer', whiteSpace:'nowrap' }}>
            Aggiorna ora
          </button>
        </div>
      )}
      {/* HOME PUBBLICA */}
      {view.type === 'home' && (
        <HomePage
          goPublic={goPublic}
          onAdminClick={() => setView({ type: 'admin-login' })}
          authUser={authUser}
          profilo={profilo}
          onLoginClick={() => setView({ type: 'login-utente' })}
          onRegistrazioneClick={() => setView({ type: 'registrazione' })}
          onAreaPersonaleClick={() => setView({ type: 'area-personale' })}
          onLogoutUtente={handleLogoutUtente}
          isAdminDomain={isAdminDomain}
        />
      )}

      {/* LOGIN UTENTE PUBBLICO */}
      {view.type === 'login-utente' && !isAdminDomain && (
        <LoginUtentePage
          onLogin={handleLoginUtente}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: view.returnTo })}
          onBack={view.returnTo ? () => setView(view.returnTo) : goHome}
          onSuccess={() => view.returnTo ? setView(view.returnTo) : setView({ type: 'area-personale' })}
        />
      )}

      {/* REGISTRAZIONE UTENTE */}
      {view.type === 'registrazione' && !isAdminDomain && (
        <RegistrazionePage
          onRegistra={handleRegistrazione}
          onLogin={() => setView({ type: 'login-utente', returnTo: view.returnTo })}
          onBack={view.returnTo ? () => setView(view.returnTo) : goHome}
          onSuccess={() => view.returnTo ? setView(view.returnTo) : setView({ type: 'area-personale' })}
        />
      )}

      {/* AREA PERSONALE UTENTE */}
      {view.type === 'area-personale' && !isAdminDomain && (
        authUser
          ? <AreaPersonale
              authUser={authUser}
              profilo={profilo}
              goTo={goPublic}
              onBack={goHome}
              onLogout={handleLogoutUtente}
            />
          : <LoginUtentePage
              onLogin={handleLoginUtente}
              onRegistrati={() => setView({ type: 'registrazione' })}
              onBack={goHome}
              onSuccess={() => setView({ type: 'area-personale' })}
            />
      )}

      {/* LOGIN ADMIN */}
      {view.type === 'admin-login' && (
        <LoginPage onLogin={handleLogin} onBack={isAdminDomain ? null : goHome} />
      )}

      {/* AREA GESTIONALE ADMIN */}
      {view.type === 'admin' && currentUser && (
        <AdminApp user={currentUser} onLogout={handleLogout} goPublic={goPublic} />
      )}

      {/* MODULI PUBBLICI — login obbligatorio per prenotare/iscriversi */}
      {view.type === 'evento' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="iscriverti all'evento" icona="🎪"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'evento', id: view.id } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'evento', id: view.id } })}>
          <PubEventoForm eventoId={view.id} onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'campetto' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="prenotare il campetto" icona="⚽"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'campetto' } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'campetto' } })}>
          <PubCampettoForm onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'sala' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="prenotare la sala feste" icona="🎉"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'sala' } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'sala' } })}>
          <PubSalaForm onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'appartamento' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="prenotare l'appartamento" icona="🏡"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'appartamento' } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'appartamento' } })}>
          <PubAppartamentoForm onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'aule' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="prenotare un'aula" icona="🏫"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'aule' } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'aule' } })}>
          <PubAuleForm onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'tavoli' && !isAdminDomain && (
        <LoginGate authUser={authUser} titolo="prenotare un tavolo" icona="🍽️"
          onLogin={() => setView({ type: 'login-utente', returnTo: { type: 'tavoli' } })}
          onRegistrati={() => setView({ type: 'registrazione', returnTo: { type: 'tavoli' } })}>
          <PubTavoliForm onBack={goHome} authUser={authUser} profilo={profilo} />
        </LoginGate>
      )}
      {view.type === 'buoni'    && !isAdminDomain && <PubBuoniForm eventoId={view.id} iscrizioneId={view.iscrizioneId} onBack={goHome} />}
      {view.type === 'genitore' && !isAdminDomain && <GenitoreArea goTo={goPublic} onBack={goHome} codiceAuto={view.codiceAuto} resetToken={view.resetToken} />}
    </>
  )
}

// ─── HOME PAGE PUBBLICA ───────────────────────────────────────────────────────
function HomePage({ goPublic, onAdminClick, authUser, profilo, onLoginClick, onRegistrazioneClick, onAreaPersonaleClick, onLogoutUtente, isAdminDomain }) {
  const [eventi, setEventi] = useState([])
  const [numeri, setNumeri] = useState([])
  const [avvisi, setAvvisi] = useState([])
  const [appuntamenti, setAppuntamenti] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const carica = async () => {
      try {
        const [
          { data: ev, error: errEv },
          { data: num, error: errNum },
          { data: avv, error: errAvv },
          { data: cal, error: errCal }
        ] = await Promise.all([
          supabase.from('eventi').select('id,nome,data_inizio,data_fine').eq('attivo', true).order('created_at', { ascending: true }),
          supabase.from('configurazioni').select('valore').eq('id','homepage_numeri').maybeSingle(),
          supabase.from('avvisi_pubblici').select('*').eq('attivo', true).order('created_at', { ascending: false }),
          supabase.from('calendario_homepage').select('*').order('data', { ascending: true })
        ])

        if (errEv) console.error('Errore eventi:', errEv)
        if (errNum) console.error('Errore numeri:', errNum)
        if (errAvv) console.error('Errore avvisi:', errAvv)
        if (errCal) console.error('Errore calendario:', errCal)

        setEventi(ev || [])
        setNumeri(num?.valore?.numeri || [])
        setAvvisi(avv || [])
        setAppuntamenti(cal || [])
      } catch (e) {
        console.error('Errore caricamento homepage:', e)
      } finally {
        setLoaded(true)
      }
    }
    carica()
  }, [])

  const spazi = [
    { icon: '⚽', label: 'Campetto',     type: 'campetto',     desc: 'Campo da gioco all\'aperto',  grad: 'linear-gradient(135deg,#fde8b0 0%,#fac172 100%)', accent: '#c8860a' },
    { icon: '🎉', label: 'Sala Feste',   type: 'sala',         desc: 'Per eventi e ricorrenze',     grad: 'linear-gradient(135deg,#d4f3ee 0%,#89d5c9 100%)', accent: '#1a7a72' },
    { icon: '🍽️', label: 'Tavoli Feste', type: 'tavoli',       desc: 'Area feste e sagre',          grad: 'linear-gradient(135deg,#ffe8d0 0%,#e67e22 100%)', accent: '#a05010' },
    { icon: '🏠', label: 'Appartamento', type: 'appartamento', desc: 'Pernottamento e soggiorni',   grad: 'linear-gradient(135deg,#ffe0d0 0%,#ff8357 100%)', accent: '#c04020' },
    { icon: '🏫', label: 'Aule',         type: 'aule',         desc: 'Laboratori e incontri',       grad: 'linear-gradient(135deg,#e4f3c8 0%,#adc865 100%)', accent: '#4a6c0f' },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#f5f2ee', fontFamily: "'Outfit', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Outfit:wght@300;400;500;600;700&display=swap');

        .hp-fadeup { opacity: 0; transform: translateY(20px); animation: hpFadeUp .5s ease forwards; }
        @keyframes hpFadeUp { to { opacity: 1; transform: none; } }

        /* Blob fluttuante nella sidebar */
        .hp-blob1 {
          position: absolute; width: 220px; height: 220px; border-radius: 50%;
          background: rgba(255,255,255,.12); top: -60px; right: -60px;
          animation: blobFloat 7s ease-in-out infinite;
        }
        .hp-blob2 {
          position: absolute; width: 160px; height: 160px; border-radius: 50%;
          background: rgba(255,255,255,.08); bottom: 120px; left: -50px;
          animation: blobFloat 9s ease-in-out infinite reverse;
        }
        .hp-blob3 {
          position: absolute; width: 80px; height: 80px; border-radius: 50%;
          background: rgba(250,193,114,.35); bottom: 260px; right: 10px;
          animation: blobFloat 6s ease-in-out infinite 1s;
        }
        @keyframes blobFloat {
          0%,100% { transform: translateY(0) scale(1); }
          50%      { transform: translateY(-18px) scale(1.06); }
        }

        .hp-spazio { transition: transform .22s ease, box-shadow .22s ease; cursor: pointer; }
        .hp-spazio:hover { transform: translateY(-6px); box-shadow: 0 22px 52px rgba(0,0,0,.16) !important; }
        .hp-evento-card { transition: box-shadow .2s, transform .2s; }
        .hp-evento-card:hover { transform: translateY(-2px); box-shadow: 0 10px 32px rgba(226,91,69,.14) !important; }
        .hp-btn-g { transition: all .18s; }
        .hp-btn-g:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.25) !important; filter: brightness(1.05); }
        .hp-btn-a { transition: all .18s; }
        .hp-btn-a:hover { background: rgba(255,255,255,.22) !important; transform: translateY(-1px); }
        .hp-contact-link { transition: all .16s; display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.8); font-size: .8rem; text-decoration: none; padding: 7px 10px; border-radius: 8px; font-weight: 500; }
        .hp-contact-link:hover { background: rgba(255,255,255,.15); color: #fff; }

        @media (max-width: 768px) {
          .hp-layout { flex-direction: column !important; }
          .hp-sidebar { width: 100% !important; height: auto !important; position: relative !important; padding: 28px 24px 24px !important; }
          .hp-main { padding: 28px 18px !important; }
          .hp-spazi-grid { grid-template-columns: 1fr 1fr !important; }
          .hp-info-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 480px) {
          .hp-spazi-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div className="hp-layout" style={{ display: 'flex', minHeight: '100vh' }}>

        {/* ── SIDEBAR ── */}
        <div className="hp-sidebar" style={{
          width: 260, flexShrink: 0,
          background: 'linear-gradient(170deg, #C44030 0%, #E25B45 35%, #FF8357 70%, #FAC172 100%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '44px 20px 32px',
          position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
          boxShadow: '6px 0 40px rgba(196,64,48,.35)',
          overflow: 'hidden',
        }}>
          {/* Blob decorativi animati */}
          <div className="hp-blob1" />
          <div className="hp-blob2" />
          <div className="hp-blob3" />

          {/* Contenuto sopra il blob */}
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', flex: 1 }}>

            {/* ── Logo grande ── */}
            <div style={{
              width: 130, height: 130,
              borderRadius: 28,
              background: 'rgba(255,255,255,.28)',
              backdropFilter: 'blur(12px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 20,
              boxShadow: '0 8px 32px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.4)',
              border: '1.5px solid rgba(255,255,255,.35)',
            }}>
              <img src="/logo-oratorio.png" alt="Logo Oratorio"
                style={{ width: 108, height: 108, objectFit: 'contain',
                  filter: 'drop-shadow(0 3px 8px rgba(0,0,0,.22))' }} />
            </div>

            {/* Nome */}
            <div style={{ fontSize: '.62rem', fontWeight: 800, letterSpacing: '2.8px',
              textTransform: 'uppercase', color: 'rgba(255,255,255,.75)', marginBottom: 6 }}>
              Oratorio di
            </div>
            <h1 style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '2.1rem', fontWeight: 900, lineHeight: 1.05,
              color: '#fff', marginBottom: 8, textAlign: 'center',
              textShadow: '0 2px 16px rgba(0,0,0,.2)',
            }}>Sergnano</h1>
            <p style={{ fontSize: '.76rem', color: 'rgba(255,255,255,.68)', lineHeight: 1.6,
              textAlign: 'center', marginBottom: 28, maxWidth: 180 }}>
              Portale ufficiale per prenotazioni e iscrizioni
            </p>

            {/* Divisore */}
            <div style={{ width: '80%', height: 1, background: 'rgba(255,255,255,.2)', marginBottom: 24 }} />

            {/* ── Contatti ── */}
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'auto' }}>
              <div style={{ fontSize: '.62rem', fontWeight: 800, letterSpacing: '1.8px',
                textTransform: 'uppercase', color: 'rgba(255,255,255,.5)', marginBottom: 6, paddingLeft: 10 }}>
                Contatti
              </div>

              {/* Telefono */}
              <a href="tel:037341123" className="hp-contact-link">
                <div style={{
                  width: 30, height: 30, borderRadius: 8,
                  background: 'rgba(255,255,255,.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1rem', flexShrink: 0,
                }}>📞</div>
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: '#fff' }}>0373 41123</div>
                  <div style={{ fontSize: '.68rem', color: 'rgba(255,255,255,.55)' }}>Telefono</div>
                </div>
              </a>

              {/* Instagram */}
              <a href="https://instagram.com/oratorio.sergnano" target="_blank" rel="noreferrer" className="hp-contact-link">
                <div style={{
                  width: 30, height: 30, borderRadius: 8,
                  background: 'rgba(255,255,255,.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1rem', flexShrink: 0,
                }}>📷</div>
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: '#fff' }}>oratorio.sergnano</div>
                  <div style={{ fontSize: '.68rem', color: 'rgba(255,255,255,.55)' }}>Instagram</div>
                </div>
              </a>

              {/* Facebook */}
              <a href="https://www.facebook.com/p/Oratorio-San-Francesco-e-Santa-Chiara-Sergnano-61571720129265/" target="_blank" rel="noreferrer" className="hp-contact-link">
                <div style={{
                  width: 30, height: 30, borderRadius: 8,
                  background: 'rgba(255,255,255,.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1rem', flexShrink: 0,
                }}>👥</div>
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: '#fff' }}>oratorio.sergnano</div>
                  <div style={{ fontSize: '.68rem', color: 'rgba(255,255,255,.55)' }}>Facebook</div>
                </div>
              </a>
            </div>

            {/* ── Bottoni accesso ── */}
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 28 }}>
              {authUser ? (
                <>
                  {/* Utente loggato */}
                  <div style={{ background: 'rgba(255,255,255,.15)', borderRadius: 10,
                    padding: '8px 12px', marginBottom: 4 }}>
                    <div style={{ fontSize: '.7rem', color: 'rgba(255,255,255,.6)',
                      textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 2 }}>
                      Connesso come
                    </div>
                    <div style={{ fontWeight: 800, color: '#fff', fontSize: '.88rem' }}>
                      {profilo?.nome || authUser.email}
                    </div>
                  </div>
                  <button className="hp-btn-g" onClick={onAreaPersonaleClick} style={{
                    background: '#fff', border: 'none', borderRadius: 12,
                    padding: '12px 16px', color: '#E25B45',
                    fontSize: '.84rem', fontWeight: 700, cursor: 'pointer',
                    boxShadow: '0 4px 18px rgba(0,0,0,.18)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  }}>
                    <span>👤</span> La mia area
                  </button>
                  <button className="hp-btn-a" onClick={onLogoutUtente} style={{
                    background: 'rgba(255,255,255,.14)', border: '1.5px solid rgba(255,255,255,.3)',
                    borderRadius: 12, padding: '10px 16px',
                    color: 'rgba(255,255,255,.75)', fontSize: '.78rem', fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  }}>
                    <span>🚪</span> Esci
                  </button>
                </>
              ) : (
                <>
                  {/* Utente non loggato */}
                  <button className="hp-btn-g" onClick={onLoginClick} style={{
                    background: '#fff', border: 'none', borderRadius: 12,
                    padding: '12px 16px', color: '#E25B45',
                    fontSize: '.84rem', fontWeight: 700, cursor: 'pointer',
                    boxShadow: '0 4px 18px rgba(0,0,0,.18)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  }}>
                    <span>🔓</span> Accedi
                  </button>
                  <button className="hp-btn-a" onClick={onRegistrazioneClick} style={{
                    background: 'rgba(255,255,255,.2)', border: '1.5px solid rgba(255,255,255,.4)',
                    borderRadius: 12, padding: '10px 16px',
                    color: '#fff', fontSize: '.82rem', fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  }}>
                    <span>✏️</span> Registrati
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── CONTENUTO PRINCIPALE ── */}
        <div className="hp-main" style={{ flex: 1, padding: '44px 44px', display: 'flex', flexDirection: 'column' }}>

          {/* ── EVENTI ── */}
          {loaded && eventi.length > 0 && (
            <div className="hp-fadeup" style={{ marginBottom: 40, animationDelay: '.05s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#E25B45,#FF8357)', borderRadius: 99 }} />
                <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#2d2420', margin: 0 }}>Iscrizioni aperte</h2>
                <span style={{ background: '#E25B45', color: '#fff', borderRadius: 999,
                  fontSize: '.65rem', fontWeight: 800, padding: '2px 9px' }}>{eventi.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {eventi.map((ev, idx) => (
                  <div key={ev.id} className="hp-evento-card" style={{
                    background: '#fff', borderRadius: 14, border: '1px solid #ede8e4',
                    padding: '16px 20px', boxShadow: '0 2px 12px rgba(0,0,0,.05)',
                    display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                    animationDelay: `${.1 + idx * .06}s`,
                  }}>
                    <div style={{ width: 4, height: 38, borderRadius: 99, flexShrink: 0,
                      background: 'linear-gradient(180deg,#E25B45,#FAC172)' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '.95rem', color: '#2d2420',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.nome}</div>
                      <div style={{ fontSize: '.77rem', color: '#9b8b85', marginTop: 2 }}>
                        📅 {ev.data_inizio}{ev.data_fine && ev.data_fine !== ev.data_inizio ? ' — ' + ev.data_fine : ''}
                      </div>
                    </div>
                    <button onClick={() => goPublic('evento', ev.id)} style={{
                      background: '#E25B45', color: '#fff', border: 'none',
                      borderRadius: 10, padding: '9px 20px', fontWeight: 700,
                      fontSize: '.82rem', cursor: 'pointer', flexShrink: 0,
                      boxShadow: '0 4px 14px rgba(226,91,69,.3)', transition: 'all .18s',
                    }}
                      onMouseOver={e => { e.currentTarget.style.background='#FF8357'; e.currentTarget.style.transform='translateY(-1px)' }}
                      onMouseOut={e => { e.currentTarget.style.background='#E25B45'; e.currentTarget.style.transform='' }}>
                      Iscriviti →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── SPAZI ── */}
          <div className="hp-fadeup" style={{ animationDelay: '.15s', marginBottom: 36 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#89D5C9,#ADC865)', borderRadius: 99 }} />
              <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#2d2420', margin: 0 }}>Prenota uno spazio</h2>
            </div>
            <div className="hp-spazi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }}>
              {spazi.map((sp) => (
                <div key={sp.type} className="hp-spazio"
                  onClick={() => goPublic(sp.type)}
                  style={{ background: sp.grad, borderRadius: 16, padding: '22px 20px 18px',
                    boxShadow: '0 4px 18px rgba(0,0,0,.08)', border: '1px solid rgba(255,255,255,.5)' }}>
                  <div style={{
                    width: 46, height: 46, borderRadius: 13, marginBottom: 12,
                    background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.4rem', boxShadow: '0 2px 8px rgba(0,0,0,.08)',
                  }}>{sp.icon}</div>
                  <div style={{ fontWeight: 800, fontSize: '.94rem', color: '#2d2420', marginBottom: 3 }}>{sp.label}</div>
                  <div style={{ fontSize: '.75rem', color: '#5a4840', lineHeight: 1.5, marginBottom: 12 }}>{sp.desc}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: '.76rem', fontWeight: 700, color: sp.accent }}>
                    Prenota
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── AVVISI PUBBLICI ── */}
          {loaded && avvisi.length > 0 && (
            <div className="hp-fadeup" style={{ marginBottom: 40, animationDelay: '.1s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#adc865,#27ae60)', borderRadius: 99 }} />
                <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#2d2420', margin: 0 }}>Comunicazioni e Avvisi</h2>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {avvisi.map((av, idx) => (
                  <div key={av.id} style={{
                    background: '#fff', borderRadius: 14, border: '1px solid #ede8e4',
                    padding: '16px 20px', boxShadow: '0 2px 12px rgba(0,0,0,.05)',
                    animationDelay: `${.15 + idx * .06}s`,
                  }}>
                    <div style={{ fontWeight: 800, fontSize: '.95rem', color: '#2d2420', marginBottom: 4 }}>{av.titolo}</div>
                    {av.testo && <div style={{ fontSize: '.82rem', color: '#9b8b85', lineHeight: 1.5 }}>{av.testo}</div>}
                    <div style={{ fontSize: '.65rem', color: '#c5b8b3', marginTop: 8, fontWeight: 600 }}>
                      📅 Pubblicato il {new Date(av.created_at).toLocaleDateString('it')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── L'ORATORIO IN NUMERI ── */}
          {loaded && numeri.length > 0 && (
            <div className="hp-fadeup" style={{ marginBottom: 40, animationDelay: '.2s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#fac172,#ff8357)', borderRadius: 99 }} />
                <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#2d2420', margin: 0 }}>L'oratorio in numeri</h2>
              </div>
              <div className="hp-info-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                {numeri.map((n, idx) => (
                  <div key={n.id} style={{ 
                    background: '#fff', borderRadius: 14, padding: '18px 12px', textAlign: 'center',
                    border: '1px solid #ede8e4', boxShadow: '0 2px 10px rgba(0,0,0,.04)',
                    borderTop: `4px solid ${n.color}`
                  }}>
                    <div style={{ fontSize: '1.6rem', fontWeight: 900, color: n.color, fontFamily: "'Nunito', sans-serif" }}>{n.val}</div>
                    <div style={{ fontSize: '.68rem', color: '#9b8b85', fontWeight: 700, textTransform: 'uppercase', marginTop: 4, letterSpacing: '.5px' }}>{n.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── APPUNTAMENTI / CALENDARIO ── */}
          {loaded && appuntamenti.length > 0 && (
            <div className="hp-fadeup" style={{ marginBottom: 40, animationDelay: '.3s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#3498db,#2980b9)', borderRadius: 99 }} />
                <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#2d2420', margin: 0 }}>Prossimi Appuntamenti</h2>
              </div>
              <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #ede8e4', overflow: 'hidden' }}>
                {appuntamenti.map((cal, idx) => (
                  <div key={cal.id} style={{ 
                    padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16,
                    borderBottom: idx === appuntamenti.length - 1 ? 'none' : '1px solid #f5f2ee'
                  }}>
                    <div style={{ 
                      width: 50, textAlign: 'center', background: '#fef2f0', borderRadius: 10, padding: '6px 0',
                      border: '1px solid rgba(226,91,69,.1)'
                    }}>
                      <div style={{ fontSize: '.65rem', fontWeight: 800, color: '#E25B45', textTransform: 'uppercase' }}>
                        {new Date(cal.data + 'T12:00:00').toLocaleDateString('it', { month: 'short' })}
                      </div>
                      <div style={{ fontSize: '1.2rem', fontWeight: 900, color: '#2d2420', lineHeight: 1 }}>
                        {new Date(cal.data + 'T12:00:00').getDate()}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: '.92rem', color: '#2d2420' }}>{cal.titolo}</div>
                      <div style={{ fontSize: '.76rem', color: '#9b8b85', marginTop: 2, display: 'flex', gap: 10 }}>
                        {cal.orario && <span>🕒 {cal.orario}</span>}
                        {cal.luogo && <span>📍 {cal.luogo}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── INFO / CONTATTI ── */}
          <div className="hp-fadeup hp-info-grid" style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12,
            animationDelay: '.4s', marginBottom: 32,
          }}>
            {/* Dove siamo */}
            <div style={{ background: '#fff', borderRadius: 14, padding: '18px 18px',
              border: '1px solid #ede8e4', boxShadow: '0 2px 10px rgba(0,0,0,.04)' }}>
              <div style={{ fontSize: '1.4rem', marginBottom: 10 }}>📍</div>
              <div style={{ fontWeight: 800, fontSize: '.84rem', color: '#2d2420', marginBottom: 4 }}>Dove siamo</div>
              <div style={{ fontSize: '.75rem', color: '#9b8b85', lineHeight: 1.6 }}>
                Via Al Binengo 3<br/>Sergnano (CR)<br/>26010
              </div>
            </div>

            {/* Orari */}
            <div style={{ background: '#fdf6f0', borderRadius: 14, padding: '18px 18px',
              border: '1px solid rgba(226,91,69,.15)', boxShadow: '0 2px 10px rgba(0,0,0,.04)' }}>
              <div style={{ fontSize: '1.4rem', marginBottom: 10 }}>🕐</div>
              <div style={{ fontWeight: 800, fontSize: '.84rem', color: '#2d2420', marginBottom: 4 }}>Orari Oratorio</div>
              <div style={{ fontSize: '.75rem', color: '#9b8b85', lineHeight: 1.6 }}>
                mar – Sab: 15:30 → 18:00<br/> Dom: 11:00 → 12:00<br/>15:30 → 18:00 
              </div>
            </div>

            {/* Come contattarci */}
            <div style={{ background: '#f0faf9', borderRadius: 14, padding: '18px 18px',
              border: '1px solid rgba(137,213,201,.3)', boxShadow: '0 2px 10px rgba(0,0,0,.04)' }}>
              <div style={{ fontSize: '1.4rem', marginBottom: 10 }}>✉️</div>
              <div style={{ fontWeight: 800, fontSize: '.84rem', color: '#2d2420', marginBottom: 4 }}>Scrivici</div>
              <div style={{ fontSize: '.75rem', color: '#9b8b85', lineHeight: 1.6 }}>
                Email parrocchiale:<br/>parrocchia.sergnano@diocesidicrema.it
              </div>
            </div>
          </div>

          {/* ── FOOTER ── */}
          <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: '1px solid #ede8e4',
            fontSize: '.72rem', color: '#c5b8b3', textAlign: 'center' }}>
            Oratorio di Sergnano · Via Al Binengo · Sergnano (CR)
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── LOGIN UTENTE PUBBLICO ────────────────────────────────────────────────────
function LoginUtentePage({ onLogin, onRegistrati, onBack, onSuccess }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleSubmit = async () => {
    if (!email.trim() || !password) { setError('Inserisci email e password.'); return }
    if (isBlocked()) {
      const r = getRateLimit()
      const min = Math.ceil((r.blockedUntil - Date.now()) / 60000)
      setError(`Troppi tentativi. Riprova tra ${min} minut${min===1?'o':'i'}.`)
      return
    }
    setLoading(true); setError('')
    const err = await onLogin(email.trim().toLowerCase(), password)
    setLoading(false)
    if (err) {
      recordFailedAttempt()
      setError(err)
    } else {
      resetRateLimit()
      onSuccess()
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo-oratorio.png" alt="Logo" style={{ width: 200, height: 'auto', marginBottom: 4 }} />
          <h1>Oratorio di Sergnano</h1>
          <p>Accedi al tuo account</p>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="tuaemail@gmail.com" autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <div style={{ position: 'relative' }}>
            <input className="form-input" type={showPwd ? 'text' : 'password'}
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="••••••••" style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPwd(s => !s)}
              style={{ position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',
                background:'none',border:'none',cursor:'pointer',fontSize:'1.2rem',color:'var(--text-muted)' }}>
              {showPwd ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" style={{ width:'100%', marginBottom:12 }}
          onClick={handleSubmit} disabled={loading}>
          {loading ? <><span className="spinner" /> Accesso...</> : '🔓 Accedi'}
        </button>
        <button className="btn btn-ghost" style={{ width:'100%', marginBottom:4 }}
          onClick={onRegistrati}>
          Non hai un account? <b>Registrati</b>
        </button>
        <button className="btn btn-ghost" style={{ width:'100%', marginBottom:8, fontSize:'.82rem',
          color:'var(--text-muted)' }}
          onClick={async () => {
            const email = window.prompt('Inserisci la tua email per ricevere il link di reset:')
            if (!email) return
            const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
              redirectTo: window.location.origin + window.location.pathname + '?type=recovery',
            })
            if (error) alert('Errore: ' + error.message)
            else alert('✅ Email inviata! Controlla la tua casella e clicca il link per reimpostare la password.')
          }}>
          🔑 Password dimenticata?
        </button>
        <button className="btn btn-ghost" style={{ width:'100%', fontSize:'.82rem' }}
          onClick={onBack}>← Torna alla home</button>
      </div>
    </div>
  )
}

// ─── REGISTRAZIONE UTENTE ─────────────────────────────────────────────────────
function RegistrazionePage({ onRegistra, onLogin, onBack, onSuccess }) {
  const [form, setForm] = useState({
    nome: '', cognome: '', email: '', telefono: '', password: '', conferma: ''
  })
  const [showPwd,   setShowPwd]   = useState(false)
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)
  const [successo,  setSuccesso]  = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSubmit = async () => {
    if (!form.nome || !form.cognome || !form.email || !form.password) {
      setError('Compila tutti i campi obbligatori.'); return
    }
    if (form.password.length < 8) {
      setError('La password deve essere di almeno 8 caratteri.'); return
    }
    if (form.password !== form.conferma) {
      setError('Le password non coincidono.'); return
    }
    const emailReg = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailReg.test(form.email)) {
      setError('Inserisci un indirizzo email valido.'); return
    }
    setLoading(true); setError('')
    const err = await onRegistra({
      nome: form.nome.trim(),
      cognome: form.cognome.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      telefono: form.telefono.trim() || null,
    })
    setLoading(false)
    if (err) { setError(err); return }
    setSuccesso(true)
  }

  if (successo) return (
    <div className="login-page">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: 16 }}>🎉</div>
        <h2 style={{ color: 'var(--primary)', marginBottom: 8 }}>
          Benvenuto/a, {form.nome}!
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.6 }}>
          Il tuo account è stato creato con successo.
        </p>
        <div className="alert alert-info" style={{ textAlign:'left', marginBottom:20, fontSize:'.82rem' }}>
          📧 Potresti ricevere un'email di conferma — clicca il link al suo interno
          per attivare l'account, poi accedi normalmente.
        </div>
        <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 8 }}
          onClick={onSuccess}>
          👤 Vai alla mia area
        </button>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onLogin}>
          🔓 Accedi con le credenziali
        </button>
      </div>
    </div>
  )

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo-oratorio.png" alt="Logo" style={{ width: 200, height: 'auto', marginBottom: 4 }} />
          <h1>Oratorio di Sergnano</h1>
          <p>Crea il tuo account</p>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Nome *</label>
            <input className="form-input" value={form.nome}
              onChange={e => set('nome', e.target.value)} placeholder="Mario" />
          </div>
          <div className="form-group">
            <label className="form-label">Cognome *</label>
            <input className="form-input" value={form.cognome}
              onChange={e => set('cognome', e.target.value)} placeholder="Rossi" />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Email *</label>
          <input className="form-input" type="email" value={form.email}
            onChange={e => set('email', e.target.value)} placeholder="mario.rossi@gmail.com" />
        </div>
        <div className="form-group">
          <label className="form-label">Telefono</label>
          <input className="form-input" type="tel" value={form.telefono}
            onChange={e => set('telefono', e.target.value)} placeholder="3331234567" />
        </div>
        <div className="form-group">
          <label className="form-label">Password * <span style={{fontSize:'.75rem',color:'var(--text-muted)',fontWeight:400}}>(min. 8 caratteri)</span></label>
          <div style={{ position: 'relative' }}>
            <input className="form-input" type={showPwd ? 'text' : 'password'}
              value={form.password} onChange={e => set('password', e.target.value)}
              placeholder="••••••••" style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPwd(s => !s)}
              style={{ position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',
                background:'none',border:'none',cursor:'pointer',fontSize:'1.2rem',color:'var(--text-muted)' }}>
              {showPwd ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Conferma password *</label>
          <input className="form-input" type="password" value={form.conferma}
            onChange={e => set('conferma', e.target.value)} placeholder="••••••••" />
          {form.conferma && form.password !== form.conferma && (
            <div style={{ fontSize:'.78rem', color:'var(--danger)', marginTop:4 }}>
              ⚠️ Le password non coincidono
            </div>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className="form-label" style={{ fontSize:'.78rem', color:'var(--text-muted)', fontWeight:400, lineHeight:1.5 }}>
            Registrandoti accetti il trattamento dei dati personali ai sensi del GDPR (Reg. UE 2016/679).
          </label>
        </div>
        <button className="btn btn-primary btn-lg" style={{ width:'100%', marginBottom:12 }}
          onClick={handleSubmit} disabled={loading}>
          {loading ? <><span className="spinner" /> Registrazione...</> : '✏️ Crea account'}
        </button>
        <button className="btn btn-ghost" style={{ width:'100%', marginBottom:8 }}
          onClick={onLogin}>
          Hai già un account? <b>Accedi</b>
        </button>
        <button className="btn btn-ghost" style={{ width:'100%', fontSize:'.82rem' }}
          onClick={onBack}>← Torna alla home</button>
      </div>
    </div>
  )
}

// ─── LOGIN ADMIN ──────────────────────────────────────────────────────────────
function LoginPage({ onLogin, onBack }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [showPwd,  setShowPwd]  = useState(false)
  const [countdown, setCountdown] = useState(0)

  // Aggiorna il countdown se l'account è bloccato
  useEffect(() => {
    const tick = () => {
      if (isBlocked()) {
        const r = getRateLimit()
        setCountdown(Math.ceil((r.blockedUntil - Date.now()) / 1000))
      } else {
        setCountdown(0)
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  const handleSubmit = async () => {
    if (isBlocked()) return
    if (!email.trim() || !password) { setError('Inserisci email e password.'); return }
    setLoading(true); setError('')
    const err = await onLogin(email, password)
    setLoading(false)
    if (err) setError(err)
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo-oratorio.png" alt="Logo Oratorio" style={{ width:  350, height: 'auto', objectFit: 'contain', marginBottom: 2 }} />
          <h1>Oratorio di Sergnano</h1>
          <p>Area Riservata Amministratori</p>
        </div>
        {countdown > 0 && (
          <div className="alert alert-danger" style={{ textAlign: 'center' }}>
            🔒 Accesso bloccato per troppi tentativi.<br />
            <b>Riprova tra {Math.floor(countdown/60)}:{String(countdown%60).padStart(2,'0')}</b>
          </div>
        )}
        {error && !countdown && <div className="alert alert-danger">{error}</div>}
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="tuaemail@gmail.com" autoFocus
            disabled={countdown > 0} />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <div style={{ position: 'relative' }}>
            <input className="form-input" type={showPwd ? 'text' : 'password'}
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="••••••••" style={{ paddingRight: 48 }} />
            <button onClick={() => setShowPwd(s => !s)}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--text-muted)' }}>
              {showPwd ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 12 }}
          onClick={handleSubmit} disabled={loading}>
          {loading ? <><span className="spinner" /> Accesso in corso...</> : '🔐 Accedi'}
        </button>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onBack}>
          ← Torna alla home pubblica
        </button>
      </div>
    </div>
  )
}

// ─── ADMIN APP SHELL ──────────────────────────────────────────────────────────
function AdminApp({ user, onLogout, goPublic }) {
  const paginaIniziale = () => {
    if (user.ruolo === 'superadmin') return 'dashboard'
    const ordine = ['campetto','sala','appartamento','aule','eventi','admins','settings']
    return ordine.find(s => canManage(user.ruolo, s)) || 'dashboard'
  }
  const [page,     setPage]     = useState(paginaIniziale)
  const [sideOpen, setSideOpen] = useState(false)
  const [pushStatus, setPushStatus] = useState('idle')
  // ── Timeout inattività ───────────────────────────────────────────
  const TIMEOUT_MS = 3 * 60 * 1000  // 3 minuti
  const [locked,    setLocked]    = useState(() => {
    const isLocked = localStorage.getItem('oratorio_admin_locked') === 'true'
    const lastAct = parseInt(localStorage.getItem('oratorio_admin_last_act') || '0')
    if (isLocked) return true
    if (lastAct && (Date.now() - lastAct > TIMEOUT_MS)) return true
    return false
  })
  const [lockPwd,   setLockPwd]   = useState('')
  const [lockError, setLockError] = useState('')
  const [lockCountdown, setLockCountdown] = useState(0)
  const timerRef = useRef(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const now = Date.now()
    
    // Ottimizzazione: aggiorna localStorage solo ogni 10 secondi invece che ad ogni movimento
    const lastAct = parseInt(localStorage.getItem('oratorio_admin_last_act') || '0')
    if (now - lastAct > 10000) {
      localStorage.setItem('oratorio_admin_last_act', now.toString())
    }

    if (!locked) {
      timerRef.current = setTimeout(() => {
        setLocked(true)
        localStorage.setItem('oratorio_admin_locked', 'true')
      }, TIMEOUT_MS)
    }
  }, [locked, TIMEOUT_MS])

  useEffect(() => {
    const lastAct = parseInt(localStorage.getItem('oratorio_admin_last_act') || '0')
    if (lastAct && (Date.now() - lastAct > TIMEOUT_MS)) {
      setLocked(true)
      localStorage.setItem('oratorio_admin_locked', 'true')
    }

    const events = ['mousemove','mousedown','keydown','touchstart','scroll','click']
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()
    return () => {
      events.forEach(e => window.removeEventListener(e, resetTimer))
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [resetTimer, TIMEOUT_MS])

  const sblocca = async () => {
    if (!lockPwd.trim()) return
    if (isBlocked()) {
      const r = getRateLimit()
      setLockCountdown(Math.ceil((r.blockedUntil - Date.now()) / 1000))
      return
    }

    // Verifica password contro il DB (vecchio metodo)
    const { data } = await supabase.from('admins').select('password')
      .eq('id', user.id).single()
      
    if (data?.password === lockPwd) {
      resetRateLimit()
      setLocked(false)
      localStorage.setItem('oratorio_admin_locked', 'false')
      localStorage.setItem('oratorio_admin_last_act', Date.now().toString())
      setLockPwd('')
      setLockError('')
      resetTimer()
    } else {
      recordFailedAttempt()
      const left = getAttemptsLeft()
      setLockError(left > 0
        ? `Password errata. Tentativi rimasti: ${left}.`
        : 'Account bloccato 15 minuti.')
    }
  }

  useEffect(() => {
    aggiornaRuoliCustomLS()
    // Controlla se già iscritto alle notifiche push
    if ('Notification' in window && Notification.permission === 'granted') {
      setPushStatus('ok')
    }
  }, [])

  const abilitaNotifiche = async () => {
    setPushStatus('loading')
    console.log('Avvio abilita notifiche per:', user.id, user.ruolo)
    try {
      const userType = user.ruolo === 'superadmin' ? 'superadmin' : 'admin'
      const sub = await initWebPush(user.id, userType)
      console.log('Subscription ottenuta:', sub ? '✅' : '❌', sub?.endpoint?.slice(0,50))
      if (sub) {
        setPushStatus('ok')
      } else {
        // Controlla se davvero negato o solo non ancora concesso
        const perm = ('Notification' in window) ? Notification.permission : 'denied'
        if (perm === 'denied') {
          setPushStatus('denied')
          alert('Le notifiche sono state negate. iOS: Impostazioni → [nome app] → Notifiche → Consenti Android: Impostazioni → App → Notifiche → Attiva')
        } else {
          setPushStatus('idle')
        }
      }
    } catch (e) {
      console.warn('Errore abilita notifiche:', e)
      setPushStatus('idle')
    }
  }

  // Controlla se già iscritto alle notifiche
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      setPushStatus('ok')
    }
  }, [])

  const goHome = () => setPage(paginaIniziale())

  const navItems = [
    { id: 'dashboard',    icon: '🏠', label: 'Dashboard',  visible: user.ruolo === 'superadmin' },
    { section: 'Prenotazioni' },
    { id: 'campetto',     icon: '⚽', label: 'Campetto',      visible: canManage(user.ruolo, 'campetto') },
    { id: 'sala',         icon: '🎉', label: 'Sala Feste',    visible: canManage(user.ruolo, 'sala') },
    { id: 'feste',        icon: '🥳', label: 'Gestione Feste', visible: canManage(user.ruolo, 'feste') },
    { id: 'appartamento', icon: '🏡', label: 'Appartamento',  visible: canManage(user.ruolo, 'appartamento') },
    { id: 'aule',         icon: '🏫', label: 'Aule Interne',  visible: canManage(user.ruolo, 'aule') },
    { section: 'Eventi' },
    { id: 'eventi',       icon: '🎪', label: 'Gestione Eventi', visible: canManage(user.ruolo, 'eventi') },
    { section: 'Amministrazione' },
    { id: 'economia',     icon: '💰', label: 'Economia',        visible: canManage(user.ruolo, 'economia') },
    { id: 'homepage',     icon: '🌐', label: 'Gestione Homepage', visible: canManage(user.ruolo, 'homepage') },
    { id: 'portfolio',    icon: '🖼️', label: 'Portfolio Spazi',  visible: canManage(user.ruolo, 'homepage') },
    { id: 'admins',       icon: '👥', label: 'Gestione Admin',   visible: canManage(user.ruolo, 'admins') },
    { id: 'settings',     icon: '⚙️', label: 'Impostazioni',     visible: canManage(user.ruolo, 'settings') },
  ].filter(item => item.section !== undefined || item.visible !== false)

  const titles = {
    dashboard: 'Dashboard', campetto: 'Campetto', sala: 'Sala Feste',
    feste: 'Gestione Feste',
    appartamento: 'Appartamento', aule: 'Aule Interne',
    eventi: 'Gestione Eventi', admins: 'Gestione Admin',
    settings: 'Impostazioni', homepage: 'Gestione Homepage',
    portfolio: 'Portfolio Spazi', economia: 'Economia e Bilancio',
  }

  return (
    <div className="app">
      {/* ── SCHERMATA DI BLOCCO INATTIVITÀ ── */}
      {locked && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(45,36,32,.92)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{
            background: '#fff', borderRadius: 24, padding: '40px 36px',
            width: '100%', maxWidth: 400, textAlign: 'center',
            boxShadow: '0 24px 80px rgba(0,0,0,.4)',
          }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>🔒</div>
            <h2 style={{ fontFamily: 'Nunito,sans-serif', fontWeight: 900,
              marginBottom: 6, color: 'var(--text)' }}>Sessione bloccata</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '.88rem', marginBottom: 24 }}>
              Inattività rilevata. Reinserisci la password per continuare.
            </p>
            {lockError && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{lockError}</div>}
            {lockCountdown > 0 && (
              <div className="alert alert-danger" style={{ marginBottom: 14 }}>
                🔒 Bloccato — riprova tra {Math.floor(lockCountdown/60)}:{String(lockCountdown%60).padStart(2,'0')}
              </div>
            )}
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input
                className="form-input"
                type="password"
                placeholder="Password"
                value={lockPwd}
                onChange={e => setLockPwd(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sblocca()}
                autoFocus
                style={{ paddingRight: 48 }}
                disabled={lockCountdown > 0}
              />
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 12 }}
              onClick={sblocca} disabled={lockCountdown > 0}>
              🔓 Sblocca
            </button>
            <button className="btn btn-ghost" style={{ width: '100%', fontSize: '.82rem' }}
              onClick={onLogout}>
              Esci dall'account
            </button>
          </div>
        </div>
      )}
      <aside className={`sidebar ${sideOpen ? 'open' : ''}`} onClick={() => setSideOpen(false)}>
        <div className="sidebar-logo">
          <img src="/logo-oratorio.png" alt="Logo Oratorio" style={{ width: 120, height: 'auto', objectFit: 'contain', marginBottom: 10, filter: 'drop-shadow(0 1px 4px rgba(0,0,0,.3))' }} />
          <h1>Oratorio<br />Sergnano</h1>
          <p>Gestionale v2.0</p>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item, i) =>
            item.section
              ? <div key={i} className="nav-section">{item.section}</div>
              : <div key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>
                  <span className="icon">{item.icon}</span>{item.label}
                </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{user.nome}</div>
          <div style={{ marginBottom: 12 }}>
            <span className="badge" style={{ background: RUOLI[user.ruolo]?.color || '#666', color: '#fff' }}>
              {RUOLI[user.ruolo]?.label}
            </span>
          </div>
          <button className="btn btn-sm btn-ghost"
            style={{ color: 'rgba(255,255,255,.7)', borderColor: 'rgba(255,255,255,.3)' }}
            onClick={onLogout}>
            🚪 Esci
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="hamburger" onClick={e => { e.stopPropagation(); setSideOpen(s => !s) }}><span/><span/><span/></button>
          <h2>{titles[page]}</h2>
          <div className="topbar-user">
            <span style={{ fontSize: '.85rem', color: 'var(--text-muted)' }} className="mobile-hide">
              {new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={abilitaNotifiche}
              disabled={pushStatus === 'loading' || pushStatus === 'ok'}
              title={pushStatus === 'ok' ? 'Notifiche attive ✅' : pushStatus === 'denied' ? 'Tocca per riprovare — se non funziona vai in Impostazioni > Notifiche' : 'Abilita notifiche push'}
              style={{
                background: pushStatus === 'ok' ? '#e8f5e9' : pushStatus === 'denied' ? '#fdecea' : 'var(--primary-pale)',
                color: pushStatus === 'ok' ? '#27ae60' : pushStatus === 'denied' ? 'var(--danger)' : 'var(--primary)',
                border: 'none', borderRadius: 10, padding: '7px 12px',
                fontWeight: 700, fontSize: '.82rem', cursor: pushStatus === 'ok' ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6
              }}>
              {pushStatus === 'loading' ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Attivazione...</>
               : pushStatus === 'ok'      ? '🔔 Notifiche ON'
               : pushStatus === 'denied'  ? '🔕 Negate'
               : '🔔 Abilita notifiche'}
            </button>
            <div className="avatar">{user.nome?.[0]}</div>
          </div>
        </div>
        <div className="content">
          {page === 'dashboard'    && <Dashboard    user={user} setPage={setPage} goPublic={goPublic} />}
          {page === 'campetto'     && <AdminCampetto     user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'sala'         && <AdminSala         user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'feste'        && <AdminFeste        user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'appartamento' && <AdminAppartamento user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'aule'         && <AdminAule         user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'eventi'       && <AdminEventi       user={user} goPublic={goPublic} goBack={goHome} />}
          {page === 'homepage'     && <AdminHomepage     user={user}                     goBack={goHome} />}
          {page === 'portfolio'    && <AdminPortfolio    user={user}                     goBack={goHome} />}
          {page === 'economia'     && <AdminEconomia     user={user}                     goBack={goHome} />}
          {page === 'admins'       && <AdminAdmins       user={user}                     goBack={goHome} />}
          {page === 'settings'     && <AdminSettings     user={user}                     goBack={goHome} />}
        </div>
      </div>
    </div>
  )
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ user, setPage, goPublic }) {
  const { data: eventi }      = useSupabaseData('eventi', { order: 'created_at' })
  const { data: campetto }    = useSupabaseData('prenotazioni_campetto', { order: 'created_at' })
  const { data: sala }        = useSupabaseData('prenotazioni_sala', { order: 'created_at' })
  const { data: appartamento }= useSupabaseData('prenotazioni_appartamento', { order: 'created_at' })
  const { data: iscrizioni }  = useSupabaseData('iscrizioni', { order: 'created_at' })

  const isSuperAdmin = user.ruolo === 'superadmin'

  // Incassi e contatori visibili in base al ruolo
  const { data: logBuoniDash } = useSupabaseData('log_pagamenti_buoni', { order: 'created_at' })

  const incassoCampetto    = campetto.reduce((s, p) => s + (p.prezzo || 0), 0)
  const incassoSala        = sala.reduce((s, p) => s + (p.prezzo || 0), 0)
  const incassoIscrizioni  = iscrizioni.reduce((s, i) => s + (i.totale || 0), 0)
  const incassoBuoniDash   = logBuoniDash
    .filter(l => l.tipo === 'acquisto_pub' || l.tipo === 'acquisto_admin')
    .reduce((s, l) => s + (l.importo || 0), 0)

  const incasso = isSuperAdmin
    ? incassoIscrizioni + incassoCampetto + incassoSala + incassoBuoniDash
    : canManage(user.ruolo,'campetto')     ? incassoCampetto
    : canManage(user.ruolo,'sala')         ? incassoSala
    : canManage(user.ruolo,'eventi')       ? incassoIscrizioni
    : 0

  const incassoLabel = isSuperAdmin
    ? 'Incassi totali'
    : canManage(user.ruolo,'campetto')  ? 'Incassi campetto'
    : canManage(user.ruolo,'sala')      ? 'Incassi sala feste'
    : canManage(user.ruolo,'eventi')    ? 'Incassi iscrizioni'
    : 'Incassi'

  const prenotazioniTot = (canManage(user.ruolo,'campetto') ? campetto.length : 0)
    + (canManage(user.ruolo,'sala') ? sala.length : 0)
    + (canManage(user.ruolo,'appartamento') ? appartamento.length : 0)

  const iscrizioniSaldate = iscrizioni.filter(i => i.saldato).length
  const oggi = new Date().toLocaleDateString('it', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div>
      {/* Hero banner */}
      <div style={{
        background: 'linear-gradient(135deg,#E25B45 0%,#FF8357 60%,#FAC172 100%)',
        borderRadius: 20, padding: '32px 36px', marginBottom: 28, color: '#fff',
        position: 'relative', overflow: 'hidden'
      }}>
        <img src="/logo-oratorio.png" alt="" style={{ position: 'absolute', right: -10, top: -10, width: 160, opacity: .08, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', right: 140, bottom: -30, fontSize: '6rem', opacity: .06, lineHeight: 1 }}>⛪</div>
        <div style={{ fontWeight: 700, fontSize: '.82rem', opacity: .7, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>{oggi}</div>
        <h2 style={{ fontFamily: 'Nunito,sans-serif', fontSize: '1.8rem', fontWeight: 900, marginBottom: 6 }}>
          Buongiorno, {user.nome.split(' ')[0]}! 👋
        </h2>
        <p style={{ opacity: .75, fontSize: '.95rem' }}>Gestionale Oratorio di Sergnano — tutto sotto controllo</p>
      </div>

      {/* Stat cards */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        {canManage(user.ruolo,'eventi') && (
          <div className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => setPage('eventi')}>
            <div className="stat-icon">🎪</div>
            <div className="stat-value">{eventi.length}</div>
            <div className="stat-label">Eventi attivi</div>
          </div>
        )}
        {canManage(user.ruolo,'eventi') && (
          <div className="stat-card"
            style={{ cursor: 'pointer' }}
            onClick={() => setPage('eventi')}>
            <div className="stat-icon">📋</div>
            <div className="stat-value">{iscrizioni.length}</div>
            <div className="stat-label">Iscrizioni totali</div>
            {iscrizioni.length > 0 && (
              <div style={{ marginTop: 8, fontSize: '.75rem', color: iscrizioniSaldate === iscrizioni.length ? '#27ae60' : '#e65100', fontWeight: 700 }}>
                {iscrizioniSaldate}/{iscrizioni.length} saldate
              </div>
            )}
          </div>
        )}
        {prenotazioniTot > 0 && (
          <div className="stat-card">
            <div className="stat-icon">📅</div>
            <div className="stat-value">{prenotazioniTot}</div>
            <div className="stat-label">Prenotazioni</div>
          </div>
        )}
        {incasso > 0 && (
          <div className="stat-card">
            <div className="stat-icon">💰</div>
            <div className="stat-value" style={{ fontSize: '1.7rem', color: '#d35400' }}>{fmt(incasso)}</div>
            <div className="stat-label">{incassoLabel}</div>
          </div>
        )}
      </div>

      <div className="grid-2">
        {/* Moduli pubblici */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">🔗 Moduli Pubblici</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Prenota Campetto',     type: 'campetto',     icon: '⚽', color: 'var(--green)' },
              { label: 'Prenota Sala Feste',   type: 'sala',         icon: '🎉', color: '#8e44ad' },
              { label: 'Prenota Tavolo',       type: 'tavoli',       icon: '🍽️', color: '#e67e22' },
              { label: 'Prenota Appartamento', type: 'appartamento', icon: '🏡', color: '#d35400' },
              { label: 'Prenota Aula',         type: 'aule',         icon: '🏫', color: '#2980b9' },
            ].map(item => (
              <div key={item.type} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '11px 14px', borderRadius: 12, background: 'var(--bg)',
                border: '1.5px solid var(--border)', transition: 'all .15s', cursor: 'pointer'
              }}
              onClick={() => goPublic(item.type)}
              onMouseEnter={e => e.currentTarget.style.borderColor = item.color}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1.4rem' }}>{item.icon}</span>
                  <span style={{ fontWeight: 600, fontSize: '.92rem' }}>{item.label}</span>
                </div>
                <span style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>Apri →</span>
              </div>
            ))}
          </div>
        </div>

        {/* Link iscrizioni eventi — solo per chi gestisce eventi */}
        {canManage(user.ruolo,'eventi') && <div className="card">
          <div className="card-header">
            <div className="card-title">🎪 Iscrizioni eventi</div>
            <button className="btn btn-sm btn-primary" onClick={() => setPage('eventi')}>Gestisci →</button>
          </div>
          {eventi.length === 0
            ? <div>
                <div className="alert alert-warn" style={{ marginBottom: 12 }}>Nessun evento attivo. Creane uno!</div>
                <button className="btn btn-primary btn-sm" onClick={() => setPage('eventi')}>+ Crea evento</button>
              </div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {eventi.map(ev => {
                  const tot = iscrizioni.filter(i => i.evento_id === ev.id).length
                  const saldate = iscrizioni.filter(i => i.evento_id === ev.id && i.saldato).length
                  return (
                    <div key={ev.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '11px 14px', borderRadius: 12, background: 'var(--bg)',
                      border: '1.5px solid var(--border)'
                    }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '.92rem' }}>{ev.nome}</div>
                        <div style={{ fontSize: '.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {ev.data_inizio} → {ev.data_fine}
                          {tot > 0 && <span style={{ marginLeft: 8, color: saldate === tot ? '#27ae60' : '#e65100', fontWeight: 700 }}>
                            · {saldate}/{tot} saldate
                          </span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => goPublic('evento', ev.id)}>📋 Modulo</button>
                      </div>
                    </div>
                  )
                })}
              </div>
          }
        </div>}
      </div>
    </div>
  )
}

// ─── ADMIN EVENTI ─────────────────────────────────────────────────────────────
function AdminEventi({ user, goPublic, goBack }) {
  const { data: eventi, loading, reload } = useSupabaseData('eventi', { order: 'created_at' })
  const [showCreate, setShowCreate] = useState(false)
  const canEdit = canManage(user.ruolo, 'eventi')

  if (loading) return <LoadingPage text="Caricamento eventi..." />

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      <div style={{ marginBottom: 24 }}>
        {canEdit && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Crea nuovo evento</button>}
      </div>
      {eventi.length === 0
        ? <div className="card" style={{ textAlign: 'center', padding: 48 }}>
            <div style={{ fontSize: '3rem', marginBottom: 16 }}>🎪</div>
            <h3 style={{ color: 'var(--primary)', marginBottom: 8 }}>Nessun evento creato</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>Crea il primo evento per iniziare a raccogliere iscrizioni.</p>
            {canEdit && <button className="btn btn-primary btn-lg" onClick={() => setShowCreate(true)}>+ Crea primo evento</button>}
          </div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {eventi.map(ev => <EventoCard key={ev.id} evento={ev} canEdit={canEdit} goPublic={goPublic} onReload={reload} user={user} />)}
          </div>
      }
      {showCreate && <ModalCreaEvento user={user} onClose={() => { setShowCreate(false); reload() }} />}
    </div>
  )
}

function EventoCard({ evento, canEdit, goPublic, onReload, user }) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState('iscritti')
  const [showEdit, setShowEdit] = useState(false)
  const { data: iscrizioni, reload: reloadIscrizioni } = useSupabaseData('iscrizioni', { eq: { evento_id: evento.id }, order: 'created_at' })
  const { data: logBuoni } = useSupabaseData('log_pagamenti_buoni', { eq: { evento_id: evento.id }, order: 'created_at' })

  // Incasso iscrizioni + buoni acquistati (solo acquisti, non rimborsi)
  const incassoIscrizioni = iscrizioni.reduce((s, i) => s + (i.totale || 0), 0)
  const incassoBuoni = logBuoni
    .filter(l => l.tipo === 'acquisto_pub' || l.tipo === 'acquisto_admin')
    .reduce((s, l) => s + (l.importo || 0), 0)
  const incasso = incassoIscrizioni + incassoBuoni

  const deleteEvento = async () => {
    if (!window.confirm(`Eliminare l'evento "${evento.nome}"? Verranno eliminate anche tutte le iscrizioni.`)) return
    await supabase.from('eventi').delete().eq('id', evento.id)
    logAudit({ user, azione: 'ELIMINA_EVENTO', categoria: 'Eventi',
      dettaglio: `Eliminato evento "${evento.nome}"`,
      meta: { evento_id: evento.id, nome: evento.nome } })
    onReload()
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '20px 24px', background: 'linear-gradient(135deg,#E25B45,#FF8357)', color: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 900 }}>{evento.nome}</h3>
            <div style={{ opacity: .8, fontSize: '.85rem', marginTop: 4 }}>
              📅 {evento.data_inizio} → {evento.data_fine} &nbsp;|&nbsp; 👥 {iscrizioni.length} iscritti &nbsp;|&nbsp; 💰 {fmt(incasso)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }} onClick={() => goPublic('evento', evento.id)}>🔗 Modulo</button>
            {(evento.servizi || []).some(s => s.nome?.toLowerCase().includes('mensa')) && (
              <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }} onClick={() => goPublic('buoni', evento.id)}>🎟️ Buoni</button>
            )}
            {canEdit && <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }} onClick={() => setShowEdit(true)}>✏️ Modifica</button>}
            {canEdit && <button className="btn btn-sm" style={{ background: 'rgba(231,76,60,.5)', color: '#fff' }} onClick={deleteEvento}>🗑️</button>}
            <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }} onClick={() => setExpanded(!expanded)}>{expanded ? '▲' : '▼'}</button>
          </div>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: 24 }}>
          {(() => {
            const tutteTab = [
              { id: 'iscritti',      label: '📋 Iscritti',       perm: 'eventi.iscritti' },
              { id: 'appello',       label: '🗓️ Appello',         perm: 'eventi.appello' },
              { id: 'buoni',         label: '🎟️ Buoni Pasto',     perm: 'eventi.buoni' },
              { id: 'spese',         label: '💸 Spese',           perm: 'eventi.report' },
              { id: 'report',        label: '📊 Report',          perm: 'eventi.report' },
              { id: 'comunicazioni', label: '📣 Comunicazioni',   perm: 'eventi.comunicazioni' },
              { id: 'mail',          label: '📧 Mail',            perm: 'eventi.mail' },
            ]
            const tabVisibili = tutteTab.filter(t => !user || canManage(user.ruolo, t.perm))
            // Se la tab attiva non è più visibile, passa alla prima disponibile
            if (tabVisibili.length > 0 && !tabVisibili.find(t => t.id === tab)) {
              setTimeout(() => setTab(tabVisibili[0].id), 0)
            }
            return (
              <>
                <div className="tabs" style={{ flexWrap: 'wrap' }}>
                  {tabVisibili.map(({ id: t, label: l }) => (
                    <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
                  ))}
                </div>
                {tab === 'iscritti'      && <TabIscritti      iscrizioni={iscrizioni} evento={evento} onReload={reloadIscrizioni} user={user} />}
                {tab === 'appello'       && <TabAppello        iscrizioni={iscrizioni} evento={evento} user={user} />}
                {tab === 'buoni'         && <TabBuoniPasto     iscrizioni={iscrizioni} evento={evento} user={user} />}
                {tab === 'report'        && <TabReport         iscrizioni={iscrizioni} evento={evento} incasso={incasso} />}
                {tab === 'spese'         && <TabSpese          evento={evento} incasso={incasso} incassoBuoni={incassoBuoni} />}
                {tab === 'comunicazioni' && <TabComunicazioni  iscrizioni={iscrizioni} evento={evento} user={user} />}
                {tab === 'mail'          && <TabMail           iscrizioni={iscrizioni} evento={evento} />}
              </>
            )
          })()}
        </div>
      )}
      {showEdit && <ModalEditEvento user={user} evento={evento} onClose={() => { setShowEdit(false); onReload() }} />}
    </div>
  )
}



// ─── TAG MODAL ISCRITTI ───────────────────────────────────────────────────────
const TAG_PREDEFINITI = [
  { label: '🚨 Allergia',        color: '#e74c3c' },
  { label: '💊 Farmaco',         color: '#e67e22' },
  { label: '🎓 Borsa di studio', color: '#2980b9' },
  { label: '📞 Da contattare',   color: '#8e44ad' },
  { label: '💰 Rateizzato',      color: '#27ae60' },
  { label: '⚠️ Attenzione',      color: '#f39c12' },
  { label: '✅ Tutto ok',        color: '#16a085' },
  { label: '❌ Problema',        color: '#c0392b' },
]

function TagModal({ iscrizione, evento, user, onClose }) {
  const tagsAttuali = iscrizione.tags || []
  const [selezionati, setSelezionati] = useState(tagsAttuali.map(t => t.label))
  const [nuovaLabel,  setNuovaLabel]  = useState('')
  const [nuovoColore, setNuovoColore] = useState('#3498db')
  const [saving,      setSaving]      = useState(false)

  // Tag personalizzati (non predefiniti)
  const tagCustom = tagsAttuali.filter(t => !TAG_PREDEFINITI.find(p => p.label === t.label))
  const [customTags, setCustomTags] = useState(tagCustom)

  const toggleTag = (label) => {
    setSelezionati(p => p.includes(label) ? p.filter(x => x !== label) : [...p, label])
  }

  const aggiungiCustom = () => {
    if (!nuovaLabel.trim()) return
    const tag = { label: nuovaLabel.trim(), color: nuovoColore }
    setCustomTags(p => [...p, tag])
    setSelezionati(p => [...p, tag.label])
    setNuovaLabel(''); setNuovoColore('#3498db')
  }

  const salva = async () => {
    setSaving(true)
    // Costruisci array tag completo: predefiniti selezionati + custom selezionati
    const tuttiTag = [
      ...TAG_PREDEFINITI.filter(t => selezionati.includes(t.label)),
      ...customTags.filter(t => selezionati.includes(t.label)),
    ]
    await supabase.from('iscrizioni').update({ tags: tuttiTag }).eq('id', iscrizione.id)
    logAudit({ user, azione: 'AGGIORNA_TAG', categoria: 'Iscritti',
      dettaglio: `Tag aggiornati per ${iscrizione.nome_bambino} ${iscrizione.cognome_bambino}: ${tuttiTag.map(t=>t.label).join(', ') || 'nessuno'}`,
      meta: { iscrizione_id: iscrizione.id, tags: tuttiTag.map(t => t.label) } })
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-title">
          🏷️ Etichette — {iscrizione.nome_bambino} {iscrizione.cognome_bambino}
        </div>

        {/* Tag predefiniti */}
        <div style={{ fontWeight: 700, fontSize: '.88rem', marginBottom: 10 }}>Tag predefiniti</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
          {TAG_PREDEFINITI.map(t => {
            const sel = selezionati.includes(t.label)
            return (
              <button key={t.label} type="button" onClick={() => toggleTag(t.label)}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontWeight: 700, fontSize: '.82rem',
                  border: `2px solid ${t.color}`, cursor: 'pointer', transition: 'all .15s',
                  background: sel ? t.color : t.color + '15',
                  color: sel ? '#fff' : t.color,
                }}>
                {t.label}
              </button>
            )
          })}
        </div>

        {/* Tag personalizzati già presenti */}
        {customTags.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: '.88rem', marginBottom: 8 }}>Tag personalizzati</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {customTags.map(t => {
                const sel = selezionati.includes(t.label)
                return (
                  <button key={t.label} type="button" onClick={() => toggleTag(t.label)}
                    style={{
                      padding: '6px 14px', borderRadius: 20, fontWeight: 700, fontSize: '.82rem',
                      border: `2px solid ${t.color}`, cursor: 'pointer',
                      background: sel ? t.color : t.color + '15',
                      color: sel ? '#fff' : t.color,
                    }}>
                    {t.label}
                    <span style={{ marginLeft: 6, opacity: .7, fontSize: '.72rem' }}
                      onClick={e => { e.stopPropagation(); setCustomTags(p => p.filter(x => x.label !== t.label)); setSelezionati(p => p.filter(x => x !== t.label)) }}>
                      ✕
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Aggiungi tag personalizzato */}
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: '.85rem', marginBottom: 8 }}>+ Crea etichetta personalizzata</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="form-input" style={{ flex: 1, padding: '7px 10px' }}
              value={nuovaLabel} onChange={e => setNuovaLabel(e.target.value)}
              placeholder="es. Celiachia, Vegetariano..."
              onKeyDown={e => e.key === 'Enter' && aggiungiCustom()} />
            <input type="color" value={nuovoColore} onChange={e => setNuovoColore(e.target.value)}
              style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer' }} />
            <button className="btn btn-primary btn-sm" onClick={aggiungiCustom}
              disabled={!nuovaLabel.trim()}>+ Aggiungi</button>
          </div>
        </div>

        {/* Anteprima */}
        {selezionati.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Anteprima:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[...TAG_PREDEFINITI, ...customTags].filter(t => selezionati.includes(t.label)).map(t => (
                <span key={t.label} style={{
                  background: t.color + '22', color: t.color, border: `1.5px solid ${t.color}`,
                  borderRadius: 20, padding: '2px 10px', fontSize: '.78rem', fontWeight: 700,
                }}>{t.label}</span>
              ))}
            </div>
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" style={{ marginRight: 'auto', color: 'var(--danger)' }}
            onClick={() => setSelezionati([])}>🗑️ Rimuovi tutti</button>
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={salva} disabled={saving}>
            {saving ? <><span className="spinner" /> Salvo...</> : '💾 Salva etichette'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── QR CODE DISPLAY ──────────────────────────────────────────────────────────
// Genera QR code usando l'API pubblica di qrserver.com (no lib esterna necessaria)
function QrCodeDisplay({ username, nomeBambino, evento }) {
  // Il QR punta all'URL dell'app — il genitore scansiona e arriva direttamente al login
  const urlSito = window.location.origin + window.location.pathname
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(urlSito)}&margin=8&color=2d2420&bgcolor=ffffff`

  return (
    <div id="qr-print-area">
      <div style={{
        background: '#fff', border: '2px solid #ede8e4',
        borderRadius: 16, padding: 20, display: 'inline-block',
        boxShadow: '0 2px 16px rgba(0,0,0,.08)', maxWidth: 280,
      }}>
        {/* QR punta all'URL del sito */}
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <img
            src={qrUrl}
            alt="QR accesso Area Genitori"
            style={{ width: 200, height: 200, display: 'block', borderRadius: 8, margin: '0 auto' }}
            onError={e => { e.target.style.display = 'none' }}
          />
        </div>
        <div style={{ fontSize: '.7rem', color: '#9b8b85', textAlign: 'center', marginBottom: 12 }}>
          Scansiona per aprire l'Area Genitori
        </div>

        {/* Username */}
        <div style={{ borderTop: '1px solid #ede8e4', paddingTop: 12, marginBottom: 10 }}>
          <div style={{ fontSize: '.68rem', color: '#9b8b85', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>
            Username
          </div>
          <div style={{ fontWeight: 900, fontSize: '1rem', color: '#2d2420',
            letterSpacing: .5, fontFamily: 'monospace' }}>
            {username || '—'}
          </div>
        </div>

        {/* Spazio password da compilare a mano */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '.68rem', color: '#9b8b85', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
            Password
          </div>
          <div style={{
            borderBottom: '1.5px solid #2d2420', height: 28, width: '100%',
            position: 'relative',
          }}>
            <div style={{ position: 'absolute', right: 0, bottom: 4,
              fontSize: '.6rem', color: '#c5b8b3' }}>
              scrivi qui la tua password
            </div>
          </div>
        </div>

        {/* Nome bambino ed evento */}
        <div style={{ borderTop: '1px solid #ede8e4', paddingTop: 10, textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '.8rem', color: '#2d2420' }}>
            {nomeBambino}
          </div>
          <div style={{ fontSize: '.68rem', color: '#9b8b85', marginTop: 2 }}>
            {evento} · Oratorio di Sergnano
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── STAMPA PDF LISTA ISCRITTI ────────────────────────────────────────────────
function stampaPDF(iscrizioni, evento) {
  const oggi = new Date().toLocaleDateString('it', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  })

  // Ordina per cognome
  const ord = [...iscrizioni].sort((a, b) =>
    (a.cognome_bambino || '').localeCompare(b.cognome_bambino || '', 'it') ||
    (a.nome_bambino    || '').localeCompare(b.nome_bambino    || '', 'it')
  )

  const righe = ord.map((i, idx) => {
    const eta = i.data_nascita ? (() => {
      const n = new Date(i.data_nascita), o = new Date()
      let e = o.getFullYear() - n.getFullYear()
      if (o < new Date(o.getFullYear(), n.getMonth(), n.getDate())) e--
      return e + ' anni'
    })() : '—'
    const settimane = (i.settimane || []).map(s => 'Sett. ' + s).join(', ') || '—'
    const hasMensa  = (i.mensa_settimane || []).length > 0 ? '🍽️ Sì' : 'No'
    const saldato   = i.saldato ? '✅' : '⏳'
    const tags      = (i.tags || []).map(t => t.label).join(', ')

    return `
      <tr style="background:${idx % 2 === 0 ? '#fff' : '#f9f7f5'}">
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-weight:700">${idx + 1}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8">
          <b>${i.cognome_bambino || ''} ${i.nome_bambino || ''}</b><br>
          <span style="font-size:11px;color:#888">${i.data_nascita || '—'} · ${eta}</span>
          ${tags ? `<br><span style="font-size:10px;color:#8e44ad">${tags}</span>` : ''}
        </td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-size:12px">
          ${i.nome_genitore || ''} ${i.cognome_genitore || ''}<br>
          <span style="color:#888">${i.telefono_genitore || ''}</span>
        </td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-size:12px;text-align:center">${settimane}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-size:12px;text-align:center">${hasMensa}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-size:13px;text-align:center">${saldato}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8;font-size:13px;font-weight:700;color:#E25B45;text-align:right">
          €${Number(i.totale || 0).toFixed(2)}
        </td>
        <td style="padding:7px 10px;border-bottom:1px solid #e8e0d8"></td>
      </tr>`
  }).join('')

  const totaleIncasso = ord.reduce((s, i) => s + (i.totale || 0), 0)
  const saldate       = ord.filter(i => i.saldato).length

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Lista Iscritti — ${evento.nome}</title>
  <style>
    @page { margin: 15mm 12mm; size: A4; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #2d2420; font-size: 13px; }
    .header { display: flex; align-items: center; gap: 20px; padding-bottom: 14px;
      border-bottom: 3px solid #E25B45; margin-bottom: 18px; }
    .header-logo { width: 60px; height: 60px; object-fit: contain; }
    .header-info h1 { font-size: 18px; font-weight: 900; color: #E25B45; }
    .header-info p  { font-size: 12px; color: #888; margin-top: 3px; }
    .meta { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
    .meta-box { background: #f9f5f2; border-radius: 8px; padding: 8px 14px; border-left: 3px solid #E25B45; }
    .meta-box .val { font-size: 20px; font-weight: 900; color: #E25B45; }
    .meta-box .lbl { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .5px; }
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: #E25B45; color: #fff; }
    thead th { padding: 8px 10px; text-align: left; font-size: 11px; text-transform: uppercase;
      letter-spacing: .5px; font-weight: 700; }
    .footer { margin-top: 20px; font-size: 11px; color: #aaa; text-align: center;
      border-top: 1px solid #e8e0d8; padding-top: 10px; }
    .presenza-col { width: 60px; text-align: center; }
    @media print {
      button { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="header">
    <img class="header-logo" src="/logo-oratorio.png" alt="Logo" onerror="this.style.display='none'">
    <div class="header-info">
      <h1>Oratorio di Sergnano</h1>
      <p>Lista iscritti — ${evento.nome} · Stampato il ${oggi}</p>
      <p>${evento.data_inizio} → ${evento.data_fine}</p>
    </div>
  </div>

  <div class="meta">
    <div class="meta-box"><div class="val">${ord.length}</div><div class="lbl">Iscritti totali</div></div>
    <div class="meta-box"><div class="val">${saldate}/${ord.length}</div><div class="lbl">Iscrizioni saldate</div></div>
    <div class="meta-box"><div class="val" style="font-size:17px">€${totaleIncasso.toFixed(2)}</div><div class="lbl">Incasso totale</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th>Bambino / Ragazzo</th>
        <th>Genitore</th>
        <th style="width:90px;text-align:center">Settimane</th>
        <th style="width:55px;text-align:center">Mensa</th>
        <th style="width:45px;text-align:center">Saldato</th>
        <th style="width:65px;text-align:right">Totale</th>
        <th class="presenza-col">Presenza ✓</th>
      </tr>
    </thead>
    <tbody>${righe}</tbody>
  </table>

  <div class="footer">
    Oratorio di Sergnano · Via Al Binengo · Sergnano (CR) · Documento riservato ad uso interno
  </div>
</body>
</html>`

  const w = window.open('', '_blank', 'width=900,height=700')
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 600)
}

// ─── TAB SPESE ───────────────────────────────────────────────────────────────
function TabSpese({ evento, incasso, incassoBuoni = 0 }) {
  const [spese,     setSpese]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [showForm,  setShowForm]  = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [form, setForm] = useState({
    cifra: '', motivo: '', data: new Date().toISOString().split('T')[0], tipo_pagamento: 'contanti'
  })

  const carica = async () => {
    setLoading(true)
    const { data } = await supabase.from('spese_evento')
      .select('*').eq('evento_id', evento.id).order('data', { ascending: false })
    setSpese(data || [])
    setLoading(false)
  }

  useEffect(() => { carica() }, [evento.id])

  const salva = async () => {
    if (!form.cifra || !form.motivo || !form.data) { alert('Compila tutti i campi obbligatori.'); return }
    const cifra = parseFloat(String(form.cifra).replace(',', '.'))
    if (isNaN(cifra) || cifra <= 0) { alert('Inserisci un importo valido.'); return }
    setSaving(true)
    const { error: errSalva } = await supabase.from('spese_evento').insert([{
      evento_id: evento.id,
      cifra,
      motivo:    form.motivo,
      data:      form.data,
      pagamento: form.tipo_pagamento,
    }])
    if (errSalva) { alert('Errore salvataggio: ' + errSalva.message); setSaving(false); return }
    setSaving(false)
    setShowForm(false)
    setForm({ cifra: '', motivo: '', data: new Date().toISOString().split('T')[0], tipo_pagamento: 'contanti' })
    carica()
  }

  const elimina = async (id) => {
    if (!window.confirm('Eliminare questa spesa?')) return
    await supabase.from('spese_evento').delete().eq('id', id)
    carica()
  }

  const totaleSpese = spese.reduce((s, sp) => s + (sp.cifra || 0), 0)
  const netto       = incasso - totaleSpese

  const METODI = ['contanti', 'bonifico', 'pos', 'altro']
  const coloreMetodo = { contanti: '#27ae60', bonifico: '#2980b9', pos: '#8e44ad', altro: '#7f8c8d' }

  if (loading) return <LoadingPage text="Caricamento spese..." />

  return (
    <div>
      {/* Riepilogo economico */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Incassi iscrizioni', val: incasso - incassoBuoni, color: 'var(--green)', icon: '📋' },
          { label: 'Incassi buoni pasto', val: incassoBuoni,          color: '#16a085',       icon: '🎟️' },
          { label: 'Totale entrate',      val: incasso,               color: 'var(--green)',  icon: '💰' },
          { label: 'Spese',               val: totaleSpese,           color: '#e74c3c',       icon: '💸' },
          { label: 'Netto',               val: netto,                 color: netto >= 0 ? '#2980b9' : '#e74c3c', icon: netto >= 0 ? '📈' : '📉' },
        ].map(c => (
          <div key={c.label} style={{
            background: '#fff', border: '2px solid var(--border)', borderRadius: 14,
            padding: '16px 20px', textAlign: 'center', boxShadow: 'var(--shadow)'
          }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 4 }}>{c.icon}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 900, color: c.color }}>{fmt(c.val)}</div>
            <div style={{ fontSize: '.8rem', color: 'var(--text-muted)', marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Pulsante nuova spesa */}
      {!showForm && (
        <button className="btn btn-primary" style={{ marginBottom: 20 }} onClick={() => setShowForm(true)}>
          + Nuova spesa
        </button>
      )}

      {/* Form nuova spesa */}
      {showForm && (
        <div className="card" style={{ marginBottom: 20, background: 'var(--bg)', border: '2px solid var(--primary)' }}>
          <h4 style={{ color: 'var(--primary)', marginBottom: 16, fontWeight: 800 }}>💸 Nuova spesa</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="form-group">
              <label className="form-label">Cifra spesa (€) *</label>
              <input className="form-input" type="number" min="0" step="0.01"
                placeholder="es. 45.00"
                value={form.cifra} onChange={e => setForm(p => ({ ...p, cifra: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Data *</label>
              <input className="form-input" type="date"
                value={form.data} onChange={e => setForm(p => ({ ...p, data: e.target.value }))} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Motivo della spesa *</label>
            <input className="form-input"
              placeholder="es. Acquisto materiali, Noleggio attrezzatura..."
              value={form.motivo} onChange={e => setForm(p => ({ ...p, motivo: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Tipo di pagamento</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {METODI.map(m => (
                <button key={m} type="button"
                  onClick={() => setForm(p => ({ ...p, tipo_pagamento: m }))}
                  style={{
                    padding: '8px 16px', borderRadius: 20, fontWeight: 700, fontSize: '.85rem',
                    border: '2px solid',
                    borderColor: form.tipo_pagamento === m ? coloreMetodo[m] : 'var(--border)',
                    background: form.tipo_pagamento === m ? coloreMetodo[m] : '#fff',
                    color: form.tipo_pagamento === m ? '#fff' : 'var(--text-muted)',
                    cursor: 'pointer', textTransform: 'capitalize'
                  }}>
                  {m === 'contanti' ? '💵 Contanti' : m === 'bonifico' ? '🏦 Bonifico' : m === 'pos' ? '💳 POS' : '📦 Altro'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={salva} disabled={saving}>
              {saving ? <><span className="spinner" /> Salvataggio...</> : '💾 Salva spesa'}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Annulla</button>
          </div>
        </div>
      )}

      {/* Lista spese */}
      {spese.length === 0
        ? <div className="alert alert-info">Nessuna spesa registrata per questo evento.</div>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Data</th>
                <th>Motivo</th>
                <th>Tipo pagamento</th>
                <th style={{ textAlign: 'right' }}>Cifra</th>
                <th></th>
              </tr></thead>
              <tbody>
                {spese.map(sp => (
                  <tr key={sp.id}>
                    <td>{new Date(sp.data + 'T12:00:00').toLocaleDateString('it', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
                    <td>{sp.motivo}</td>
                    <td>
                      <span style={{
                        background: coloreMetodo[sp.pagamento] || '#7f8c8d',
                        color: '#fff', borderRadius: 20, padding: '3px 12px',
                        fontSize: '.78rem', fontWeight: 700, textTransform: 'capitalize'
                      }}>
                        {sp.pagamento === 'contanti' ? '💵 Contanti'
                          : sp.pagamento === 'bonifico' ? '🏦 Bonifico'
                          : sp.pagamento === 'pos'      ? '💳 POS'
                          : '📦 ' + (sp.pagamento || '')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800, color: '#e74c3c' }}>
                      − {fmt(sp.cifra)}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => elimina(sp.id)}>🗑️</button>
                    </td>
                  </tr>
                ))}
                <tr style={{ background: '#f8f9fa', fontWeight: 900 }}>
                  <td colSpan={3} style={{ textAlign: 'right', paddingRight: 16 }}>Totale spese</td>
                  <td style={{ textAlign: 'right', color: '#e74c3c' }}>− {fmt(totaleSpese)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  )
}

function TabIscritti({ iscrizioni: iscrizioniRaw, evento, onReload, user }) {
  const [dettaglio,   setDettaglio]   = useState(null)
  const [invioStato,  setInvioStato]  = useState({})
  const [modalFam,   setModalFam]   = useState(null)
  const [famSaving,  setFamSaving]  = useState(false)
  const [famMsg,     setFamMsg]     = useState('')
  const [famSelezionati, setFamSelezionati] = useState([])
  const [soloDaSaldare, setSoloDaSaldare] = useState(false)
  const [filtroCampo,   setFiltroCampo]   = useState('')   // id del campo extra selezionato
  const [filtroValore,  setFiltroValore]  = useState('')   // valore scelto
  const [vistaIscritti, setVistaIscritti] = useState('lista') // 'lista' | 'riepilogo'
  // ── Modifica iscritto ──
  const [modalEdit,    setModalEdit]    = useState(null)
  const [editForm,     setEditForm]     = useState({})
  const [editSaving,   setEditSaving]   = useState(false)
  const campiExtra = evento.campi_extra || []

  const [qrModal,     setQrModal]     = useState(null)
  const [tagModal,    setTagModal]    = useState(null)
  const [resetModal,  setResetModal]  = useState(null)  // iscrizione per reset password
  const [resetLink,   setResetLink]   = useState('')    // link generato
  const [resetSaving, setResetSaving] = useState(false)

  // Genera link di reset per un genitore e lo mette in resetLink
  const generaLinkReset = async (i) => {
    setResetSaving(true)
    const token = Array.from({length: 32}, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789'[
        Math.floor(Math.random() * 57)]).join('')
    const scadenza = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 ore
    await supabase.from('iscrizioni').update({
      reset_token: token,
      reset_token_scadenza: scadenza,
    }).eq('id', i.id)
    const urlBase = window.location.origin + window.location.pathname
    const link = `${urlBase}?reset=${token}`
    setResetLink(link)
    setResetSaving(false)
    logAudit({ user, azione: 'RESET_PASSWORD_GENITORE', categoria: 'Iscritti',
      dettaglio: `Generato link reset password per ${i.nome_bambino} ${i.cognome_bambino}`,
      meta: { iscrizione_id: i.id } })
  }

  const apriModifica = (i) => {
    setEditForm({
      nome_bambino:      i.nome_bambino || '',
      cognome_bambino:   i.cognome_bambino || '',
      data_nascita:      i.data_nascita || '',
      comune_residenza:  i.comune_residenza || '',
      nome_genitore:     i.nome_genitore || '',
      cognome_genitore:  i.cognome_genitore || '',
      email_genitore:    i.email_genitore || '',
      telefono_genitore: i.telefono_genitore || '',
      note:              i.note || '',
      metodo_pagamento:  i.metodo_pagamento || '',
      dati_extra:        i.dati_extra || {},
    })
    setModalEdit(i)
  }

  const salvaModifica = async () => {
    if (!editForm.nome_bambino || !editForm.cognome_bambino) { alert('Nome e cognome bambino obbligatori.'); return }
    setEditSaving(true)
    const { error } = await supabase.from('iscrizioni').update({
      nome_bambino:      editForm.nome_bambino.trim(),
      cognome_bambino:   editForm.cognome_bambino.trim(),
      data_nascita:      editForm.data_nascita || null,
      comune_residenza:  editForm.comune_residenza || null,
      nome_genitore:     editForm.nome_genitore || null,
      cognome_genitore:  editForm.cognome_genitore || null,
      email_genitore:    (editForm.email_genitore || '').trim().toLowerCase() || null,
      telefono_genitore: editForm.telefono_genitore || null,
      note:              editForm.note || null,
      metodo_pagamento:  editForm.metodo_pagamento || null,
      dati_extra:        editForm.dati_extra || {},
    }).eq('id', modalEdit.id)
    setEditSaving(false)
    if (error) { alert('Errore: ' + error.message); return }
    logAudit({ user, azione: 'MODIFICA_ISCRITTO', categoria: 'Iscritti',
      dettaglio: `Modificati dati di ${editForm.nome_bambino} ${editForm.cognome_bambino} (${evento.nome})`,
      meta: { iscrizione_id: modalEdit.id, evento_id: evento.id, evento_nome: evento.nome,
        nome_bambino: editForm.nome_bambino, cognome_bambino: editForm.cognome_bambino } })
    setModalEdit(null)
    onReload()
  }

  // Ordine alfabetico per cognome, poi nome
  const iscrizioniOrd = [...iscrizioniRaw].sort((a, b) =>
    (a.cognome_bambino || '').localeCompare(b.cognome_bambino || '', 'it') ||
    (a.nome_bambino    || '').localeCompare(b.nome_bambino    || '', 'it')
  )

  // calcEta dichiarata PRIMA di tutto (evita use-before-declaration)
  const calcEta = (dataNascita) => {
    if (!dataNascita) return null
    const oggi = new Date()
    const n = new Date(dataNascita)
    let eta = oggi.getFullYear() - n.getFullYear()
    if (oggi.getMonth() < n.getMonth() ||
        (oggi.getMonth() === n.getMonth() && oggi.getDate() < n.getDate())) eta--
    return eta
  }

  // Campi extra di tipo selezione (classe, taglia, ecc.)
  const campiExtraSelect = campiExtra.filter(c => c.tipo === 'select' || c.tipo === 'radio')

  // Tutte le categorie disponibili: built-in + ogni campo extra select
  const tutteCategorie = [
    ...(iscrizioniOrd.some(i => (i.settimane||[]).length > 0) ? [{
      id: '__settimane__', label: 'Settimane iscritte', source: 'builtin',
      conteggi: (() => {
        const c = {}
        iscrizioniOrd.forEach(i => (i.settimane||[]).forEach(s => {
          const k = 'Settimana ' + s; c[k] = (c[k]||0) + 1
        }))
        return c
      })()
    }] : []),
    ...(iscrizioniOrd.some(i => (i.mensa_settimane||[]).length > 0) ? [{
      id: '__mensa__', label: 'Mensa', source: 'builtin',
      conteggi: (() => {
        const c = {}
        const nessuna = iscrizioniOrd.filter(i => !(i.mensa_settimane||[]).length).length
        if (nessuna > 0) c['Senza mensa'] = nessuna
        iscrizioniOrd.forEach(i => (i.mensa_settimane||[]).forEach(s => {
          const k = 'Mensa sett. ' + s; c[k] = (c[k]||0) + 1
        }))
        return c
      })()
    }] : []),
    ...(iscrizioniOrd.some(i => i.data_nascita) ? [{
      id: '__eta__', label: "Fascia d'eta", source: 'builtin',
      conteggi: (() => {
        const f = {'Sotto 6 anni':0,'6-8 anni':0,'9-11 anni':0,'12-14 anni':0,'15 anni e oltre':0,'Non specificata':0}
        iscrizioniOrd.forEach(i => {
          const eta = calcEta(i.data_nascita)
          if (eta === null)  f['Non specificata']++
          else if (eta < 6)  f['Sotto 6 anni']++
          else if (eta <= 8)  f['6-8 anni']++
          else if (eta <= 11) f['9-11 anni']++
          else if (eta <= 14) f['12-14 anni']++
          else f['15 anni e oltre']++
        })
        return f
      })()
    }] : []),
    {
      id: '__saldato__', label: 'Stato pagamento', source: 'builtin',
      conteggi: {
        'Saldato': iscrizioniOrd.filter(i => i.saldato).length,
        'Da saldare': iscrizioniOrd.filter(i => !i.saldato).length,
      }
    },
    ...(iscrizioniOrd.some(i => i.comune_residenza) ? [{
      id: '__comune__', label: 'Comune di residenza', source: 'builtin',
      conteggi: (() => {
        const c = {}
        iscrizioniOrd.forEach(i => { if (i.comune_residenza) c[i.comune_residenza] = (c[i.comune_residenza]||0)+1 })
        return c
      })()
    }] : []),
    ...(iscrizioniOrd.some(i => i.is_fratello) ? [{
      id: '__fratello__', label: 'Fratelli / Sorelle', source: 'builtin',
      conteggi: {
        'Con sconto fratello': iscrizioniOrd.filter(i => i.is_fratello).length,
        'Tariffa normale':     iscrizioniOrd.filter(i => !i.is_fratello).length,
      }
    }] : []),
    ...(iscrizioniOrd.some(i => (i.servizi||[]).length > 0) ? [{
      id: '__servizi__', label: 'Servizi aggiuntivi', source: 'builtin',
      conteggi: (() => {
        const c = {}
        iscrizioniOrd.forEach(i => (i.servizi||[]).forEach(s => { c[s] = (c[s]||0)+1 }))
        return c
      })()
    }] : []),
    // Campi extra (classe frequentata, taglia maglietta, ecc.)
    ...campiExtraSelect.map(campo => {
      const opzioni = (campo.opzioni || '').split('\n').map(o => o.trim()).filter(Boolean)
      const conteggi = {}
      opzioni.forEach(o => { conteggi[o] = 0 })
      iscrizioniOrd.forEach(i => {
        const v = (i.dati_extra||{})[campo.id]
        if (v) conteggi[v] = (conteggi[v]||0) + 1
      })
      return { id: campo.id, label: campo.label, source: 'extra', campo, conteggi }
    }),
  ]

  // Funzione filtro: usa gli stessi id di tutteCategorie
  const filtraPerCategoria = (i, campoId, valore) => {
    if (!campoId || !valore) return true
    if (campoId === '__settimane__') {
      const n = parseInt(valore.replace('Settimana ', ''))
      return (i.settimane || []).map(Number).includes(n)
    }
    if (campoId === '__mensa__') {
      if (valore === 'Senza mensa') return !(i.mensa_settimane||[]).length
      const n = parseInt(valore.replace('Mensa sett. ', ''))
      return (i.mensa_settimane||[]).map(Number).includes(n)
    }
    if (campoId === '__eta__') {
      const eta = calcEta(i.data_nascita)
      if (valore === 'Sotto 6 anni')    return eta !== null && eta < 6
      if (valore === '6-8 anni')        return eta !== null && eta >= 6 && eta <= 8
      if (valore === '9-11 anni')       return eta !== null && eta >= 9 && eta <= 11
      if (valore === '12-14 anni')      return eta !== null && eta >= 12 && eta <= 14
      if (valore === '15 anni e oltre') return eta !== null && eta >= 15
      if (valore === 'Non specificata') return !i.data_nascita
      return false
    }
    if (campoId === '__saldato__')  return valore === 'Saldato' ? !!i.saldato : !i.saldato
    if (campoId === '__comune__')   return (i.comune_residenza||'') === valore
    if (campoId === '__fratello__') return valore === 'Con sconto fratello' ? !!i.is_fratello : !i.is_fratello
    if (campoId === '__servizi__')  return (i.servizi||[]).includes(valore)
    // campo extra (classe, taglia, ecc.) — confronto stringa
    return String((i.dati_extra||{})[campoId]||'') === String(valore)
  }

  // Lista iscritti con filtri applicati
  const iscrizioni = iscrizioniOrd.filter(i => {
    if (soloDaSaldare && i.saldato) return false
    if (filtroCampo && filtroValore && !filtraPerCategoria(i, filtroCampo, filtroValore)) return false
    return true
  })

  const apriModalFam = (i) => {
    // Pre-seleziona tutti quelli che già condividono lo stesso codice famiglia
    const codiceAttuale = i.codice_famiglia
    const giàUniti = codiceAttuale
      ? iscrizioni.filter(x => x.id !== i.id && x.codice_famiglia === codiceAttuale).map(x => x.id)
      : []
    setFamSelezionati(giàUniti)
    setFamMsg('')
    setModalFam(i)
  }

  const salvaFamiglia = async () => {
    setFamSaving(true)
    // Usa il codice famiglia esistente del soggetto, o uno degli selezionati, o ne genera uno nuovo
    let cod = modalFam.codice_famiglia
    if (!cod) {
      // Cerca se uno dei selezionati ha già un codice
      const conCodice = iscrizioni.find(x => famSelezionati.includes(x.id) && x.codice_famiglia)
      cod = conCodice?.codice_famiglia || genCodice()
    }
    // Salva su tutti: il soggetto + i selezionati
    const tuttiGliId = [modalFam.id, ...famSelezionati]
    await Promise.all(tuttiGliId.map(id =>
      supabase.from('iscrizioni').update({ codice_famiglia: cod }).eq('id', id)
    ))
    // Rimuovi codice famiglia dai deselezionati che lo avevano
    const deselezionati = iscrizioni.filter(x =>
      x.id !== modalFam.id &&
      x.codice_famiglia === cod &&
      !famSelezionati.includes(x.id)
    )
    await Promise.all(deselezionati.map(x =>
      supabase.from('iscrizioni').update({ codice_famiglia: null }).eq('id', x.id)
    ))
    setFamSaving(false)
    setFamMsg(`✅ Famiglia aggiornata! Codice: ${cod}`)
    onReload()
    setTimeout(() => { setModalFam(null); setFamMsg('') }, 1800)
  }

  const rimuoviFamiglia = async () => {
    if (!window.confirm('Rimuovere questa iscrizione dalla famiglia? Il codice famiglia verrà cancellato solo da questa.')) return
    await supabase.from('iscrizioni').update({ codice_famiglia: null }).eq('id', modalFam.id)
    setModalFam(null); onReload()
  }

  const remove = async (id) => {
    if (!window.confirm('Rimuovere questo iscritto?')) return
    const bersaglio = iscrizioniOrd.find(i => i.id === id)
    await supabase.from('iscrizioni').delete().eq('id', id)
    logAudit({ user, azione: 'ELIMINA_ISCRITTO', categoria: 'Iscritti',
      dettaglio: `Eliminato ${bersaglio?.nome_bambino || ''} ${bersaglio?.cognome_bambino || ''} da "${evento.nome}"`,
      meta: { iscrizione_id: id, evento_id: evento.id, evento_nome: evento.nome,
        nome_bambino: bersaglio?.nome_bambino, cognome_bambino: bersaglio?.cognome_bambino } })
    onReload()
  }

  const stampaScheda = (i) => {
    // Crea il contenuto di stampa
    const contenuto = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Scheda Iscrizione - ${i.nome_bambino} ${i.cognome_bambino}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Arial', sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      font-size: 14px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #000;
    }
    .header h1 {
      margin: 0 0 10px 0;
      font-size: 24px;
      text-transform: uppercase;
    }
    .header h2 {
      margin: 0 0 5px 0;
      font-size: 18px;
      font-weight: normal;
    }
    .header p {
      margin: 5px 0;
      font-size: 13px;
      color: #444;
    }
    .section {
      margin-bottom: 25px;
    }
    .section-title {
      font-size: 16px;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 12px;
      padding-bottom: 5px;
      border-bottom: 1px solid #000;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 15px;
    }
    .field {
      margin-bottom: 10px;
    }
    .field-label {
      font-weight: bold;
      font-size: 13px;
      margin-bottom: 2px;
    }
    .field-value {
      font-size: 14px;
      min-height: 20px;
      border-bottom: 1px solid #000;
      padding-bottom: 3px;
    }
    .signature-section {
      margin-top: 40px;
      page-break-inside: avoid;
    }
    .signature-block {
      margin-top: 30px;
      text-align: center;
    }
    .signature-line {
      border-top: 1px solid #000;
      width: 250px;
      margin: 60px auto 10px auto;
    }
    .signature-label {
      font-weight: bold;
      font-size: 13px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #000;
      text-align: center;
      font-size: 11px;
      color: #666;
    }
    @media print {
      body { margin: 0; padding: 15mm; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>ORATORIO DI SERGNANO</h1>
    <h2>SCHEDA ISCRIZIONE</h2>
    <p><strong>Evento:</strong> ${evento.nome}</p>
    <p><strong>Periodo:</strong> ${evento.data_inizio} - ${evento.data_fine}</p>
  </div>

  <div class="section">
    <div class="section-title">Dati del bambino/ragazzo</div>
    <div class="grid-2">
      ${i.nome_bambino ? `
      <div class="field">
        <div class="field-label">Nome</div>
        <div class="field-value">${i.nome_bambino || ''}</div>
      </div>` : ''}
      ${i.cognome_bambino ? `
      <div class="field">
        <div class="field-label">Cognome</div>
        <div class="field-value">${i.cognome_bambino || ''}</div>
      </div>` : ''}
      ${i.data_nascita ? `
      <div class="field">
        <div class="field-label">Data di nascita</div>
        <div class="field-value">${i.data_nascita || ''}</div>
      </div>` : ''}
      ${i.comune_residenza ? `
      <div class="field">
        <div class="field-label">Comune di residenza</div>
        <div class="field-value">${i.comune_residenza || ''}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Dati del genitore/tutore</div>
    <div class="grid-2">
      ${i.nome_genitore ? `
      <div class="field">
        <div class="field-label">Nome</div>
        <div class="field-value">${i.nome_genitore || ''}</div>
      </div>` : ''}
      ${i.cognome_genitore ? `
      <div class="field">
        <div class="field-label">Cognome</div>
        <div class="field-value">${i.cognome_genitore || ''}</div>
      </div>` : ''}
      ${i.email_genitore ? `
      <div class="field">
        <div class="field-label">Email</div>
        <div class="field-value">${i.email_genitore || ''}</div>
      </div>` : ''}
      ${i.telefono_genitore ? `
      <div class="field">
        <div class="field-label">Telefono</div>
        <div class="field-value">${i.telefono_genitore || ''}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Iscrizione</div>
    ${(i.settimane || []).length > 0 ? `
    <div class="field">
      <div class="field-label">Settimane di partecipazione</div>
      <div class="field-value">${(i.settimane || []).map(s => 'Settimana ' + s).join(', ') || ''}</div>
    </div>` : ''}
    ${(i.servizi || []).length > 0 ? `
    <div class="field">
      <div class="field-label">Servizi aggiuntivi</div>
      <div class="field-value">
        ${(() => {
          const serviziMap = {};
          (evento.servizi || []).forEach(s => serviziMap[s.id] = s.nome);
          return (i.servizi || []).map(id => serviziMap[id] || id).join(', ');
        })() || ''}
      </div>
    </div>` : ''}
    ${(i.mensa_settimane || []).length > 0 ? `
    <div class="field">
      <div class="field-label">Mensa (settimane)</div>
      <div class="field-value">${(i.mensa_settimane || []).map(s => 'Settimana ' + s).join(', ') || ''}</div>
    </div>` : ''}
    ${i.is_fratello ? `
    <div class="field">
      <div class="field-label">Sconto fratello/sorella</div>
      <div class="field-value">Sì</div>
    </div>` : ''}
    ${i.note ? `
    <div class="field">
      <div class="field-label">Note aggiuntive</div>
      <div class="field-value">${i.note || ''}</div>
    </div>` : ''}
    <div class="field">
      <div class="field-label">Totale iscrizione</div>
      <div class="field-value">€ ${i.totale ? i.totale.toFixed(2) : '0,00'}</div>
    </div>
    <div class="field">
      <div class="field-label">Saldato</div>
      <div class="field-value">${i.saldato ? 'Sì' : 'No'}</div>
    </div>
  </div>

  ${(i.dati_extra && Object.keys(i.dati_extra).length > 0) ? `
  <div class="section">
    <div class="section-title">Altre informazioni</div>
    ${(evento.campi_extra || []).map(campo => {
      if (!i.dati_extra || typeof i.dati_extra[campo.id] === 'undefined') return '';
      let valore = i.dati_extra[campo.id];
      if (campo.tipo === 'checkbox') valore = valore ? 'Sì' : 'No';
      return '<div class="field"><div class="field-label">' + campo.label + '</div><div class="field-value">' + (valore || '') + '</div></div>';
    }).join('')}
  </div>` : ''}

  <div class="signature-section">
    <div class="section-title">Firme</div>
    
    <div class="signature-block">
      <div class="signature-line"></div>
      <div class="signature-label">Firma genitore/tutore</div>
    </div>
    
    <div class="signature-block" style="margin-top: 50px;">
      <div class="signature-line"></div>
      <div class="signature-label">Firma responsabile oratorio</div>
      <div style="margin-top: 5px; font-size: 12px;">Data: ____/____/________</div>
    </div>
  </div>

  <div class="footer">
    <p>Oratorio di Sergnano - Documento generato in data: ${new Date().toLocaleDateString('it-IT')}</p>
  </div>

  <div class="no-print" style="text-align: center; margin-top: 40px;">
    <button onclick="window.print()" style="padding: 12px 30px; font-size: 16px; cursor: pointer; background: #27ae60; color: white; border: none; border-radius: 6px;">
      🖨️ Stampa
    </button>
  </div>
</body>
</html>
    `;

    // Apri una nuova finestra e scrivi il contenuto
    const finestra = window.open('', '', 'width=800,height=900');
    finestra.document.write(contenuto);
    finestra.document.close();
  }

  // Genera codice se non esiste, poi apre mailto con le credenziali
  const inviaCredenziali = async (i) => {
    setInvioStato(p => ({ ...p, [i.id]: 'sending' }))
    if (!i.email_genitore) {
      alert('Nessuna email registrata per questo iscritto.')
      setInvioStato(p => ({ ...p, [i.id]: 'error' }))
      return
    }
    if (!i.username_genitore) {
      alert('Questo iscritto non ha ancora impostato le credenziali di accesso.')
      setInvioStato(p => ({ ...p, [i.id]: 'error' }))
      return
    }
    // Genera link di reset valido 24h (il genitore imposta la password cliccando il link)
    const token = Array.from({length: 32}, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789'[
        Math.floor(Math.random() * 57)]).join('')
    const scadenza = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('iscrizioni').update({
      reset_token: token, reset_token_scadenza: scadenza
    }).eq('id', i.id)
    const urlBase = window.location.origin + window.location.pathname
    const linkReset = `${urlBase}?reset=${token}`
    const nomeEvento = evento.nome
    const nomeBambino = `${i.nome_bambino} ${i.cognome_bambino}`
    const soggetto = encodeURIComponent(`[${nomeEvento}] Credenziali Area Genitori — ${nomeBambino}`)
    const corpo = encodeURIComponent(
`Gentile genitore di ${nomeBambino},

la tua iscrizione a "${nomeEvento}" è confermata!

🔐 LE TUE CREDENZIALI DI ACCESSO:

   Username: ${i.username_genitore}

👉 Clicca qui per impostare la tua password (link valido 24 ore):
${linkReset}

Dopo aver impostato la password, accedi dall'app con username e password.

Con cordialità,
Oratorio di Sergnano`)
    window.open(`mailto:${i.email_genitore}?subject=${soggetto}&body=${corpo}`)
    setInvioStato(p => ({ ...p, [i.id]: 'sent' }))
  }

  const inviaATutti = async () => {
    if (!window.confirm(`Inviare le credenziali a tutti i ${iscrizioni.filter(i=>i.email_genitore).length} iscritti con email?`)) return
    for (const i of iscrizioni) {
      if (i.email_genitore) await inviaCredenziali(i)
    }
  }

  const esportaCsv = () => {
    const extraHeaders = campiExtra.map(c => `"${c.label}"`).join(',')
    const header = `Nome,Cognome,Nato,Email,Telefono,Settimane,Servizi,Totale${extraHeaders ? ',' + extraHeaders : ''}`
    const rows = iscrizioni.map(i => {
      const extraVals = campiExtra.map(c => `"${(i.dati_extra || {})[c.id] || ''}"`).join(',')
      const mensaSett = (i.mensa_settimane||[]).length > 0 ? `mensa sett.${(i.mensa_settimane||[]).join(',')}` : ''
      return `${i.nome_bambino},${i.cognome_bambino},${i.data_nascita || ''},${i.email_genitore || ''},${i.telefono_genitore || ''},"${(i.settimane||[]).join(' | ')}","${[(i.servizi||[]).join(' | '), mensaSett].filter(Boolean).join(' | ')}",${i.totale}${extraVals ? ',' + extraVals : ''}`
    })
    const a = document.createElement('a')
    a.href = 'data:text/csv,' + encodeURIComponent([header, ...rows].join('\n'))
    a.download = `${evento.nome}-iscritti.csv`
    a.click()
  }

  if (iscrizioni.length === 0) return <div className="alert alert-info">Nessun iscritto ancora.</div>
  return (
    <div>
      {/* ── Switcher lista / riepilogo ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['lista','📋 Lista iscritti'],['riepilogo','📊 Riepilogo categorie']].map(([v,l]) => (
          <button key={v} type="button"
            onClick={() => setVistaIscritti(v)}
            style={{
              padding: '7px 16px', borderRadius: 20, fontWeight: 700, fontSize: '.84rem',
              border: '2px solid', cursor: 'pointer',
              borderColor: vistaIscritti === v ? 'var(--primary)' : 'var(--border)',
              background: vistaIscritti === v ? 'var(--primary)' : '#fff',
              color: vistaIscritti === v ? '#fff' : 'var(--text-muted)',
            }}>{l}</button>
        ))}
      </div>

      {vistaIscritti === 'riepilogo' ? (
        /* ── VISTA RIEPILOGO CATEGORIE ── */
        <div>
          {tutteCategorie.length === 0 ? (
            <div className="alert alert-info">Nessuna categoria disponibile per questo evento.</div>
          ) : tutteCategorie.map(({ id, label, conteggi, source, campo }) => {
            const totEntries = Object.values(conteggi).reduce((s,n)=>s+n,0)
            // Per fonte 'extra' i nominativi vengono cercati nei dati_extra
            // Per fonte 'builtin' usiamo una funzione ad hoc
            const getNominativi = (val) => {
              if (source === 'extra') return iscrizioniOrd.filter(i => (i.dati_extra||{})[campo.id] === val)
              if (id === '__settimane__') return iscrizioniOrd.filter(i => (i.settimane||[]).includes(parseInt(val.replace('Settimana ',''))))
              if (id === '__mensa__') {
                if (val === 'Senza mensa') return iscrizioniOrd.filter(i => !(i.mensa_settimane||[]).length)
                const s = parseInt(val.replace('Mensa sett. ',''))
                return iscrizioniOrd.filter(i => (i.mensa_settimane||[]).includes(s))
              }
              if (id === '__eta__') {
                const fasce = {
                  'Sotto 6 anni':    i=>{ const e=calcEta(i.data_nascita); return e!==null&&e<6 },
                  '6-8 anni':        i=>{ const e=calcEta(i.data_nascita); return e!==null&&e>=6&&e<=8 },
                  '9-11 anni':       i=>{ const e=calcEta(i.data_nascita); return e!==null&&e>=9&&e<=11 },
                  '12-14 anni':      i=>{ const e=calcEta(i.data_nascita); return e!==null&&e>=12&&e<=14 },
                  '15 anni e oltre': i=>{ const e=calcEta(i.data_nascita); return e!==null&&e>=15 },
                  'Non specificata': i=>!i.data_nascita
                }
                return iscrizioniOrd.filter(fasce[val] || (() => false))
              }
              if (id === '__saldato__') return iscrizioniOrd.filter(i => val === 'Saldato' ? !!i.saldato : !i.saldato)
              if (id === '__comune__') return iscrizioniOrd.filter(i => i.comune_residenza === val)
              if (id === '__fratello__') return iscrizioniOrd.filter(i => val.startsWith('Con') ? i.is_fratello : !i.is_fratello)
              if (id === '__servizi__') return iscrizioniOrd.filter(i => (i.servizi||[]).includes(val))
              return []
            }
            const colori = ['#E25B45','#FF8357','#FAC172','#89D5C9','#ADC865','#9b8b85','#e0a050','#5b8ee2']
            return (
              <div key={id} className="card" style={{ marginBottom: 16 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
                  <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--primary)' }}>
                    {source === 'extra' ? '🏷️' : '📊'} {label}
                  </div>
                  <span style={{ fontSize: '.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                    {totEntries} totale · {iscrizioniOrd.length} iscritti
                  </span>
                </div>

                {/* Barre orizzontali */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                  {Object.entries(conteggi)
                    .filter(([,cnt]) => cnt > 0)
                    .sort((a,b) => b[1]-a[1])
                    .map(([val, cnt], idx) => {
                      const pct = iscrizioniOrd.length > 0 ? Math.round((cnt/iscrizioniOrd.length)*100) : 0
                      const col = colori[idx % colori.length]
                      return (
                        <div key={val}>
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:'.83rem', fontWeight:600, marginBottom:4 }}>
                            <span style={{ color: 'var(--text)' }}>{val}</span>
                            <span style={{ color: col, fontWeight:800 }}>{cnt} <span style={{ color:'var(--text-muted)', fontWeight:500 }}>({pct}%)</span></span>
                          </div>
                          <div style={{ background:'var(--border)', borderRadius:999, height:10, overflow:'hidden' }}>
                            <div style={{ width:`${pct}%`, background:col, height:'100%', borderRadius:999, transition:'width .5s ease' }} />
                          </div>
                        </div>
                      )
                    })
                  }
                </div>

                {/* Lista nominativi espandibile per categoria */}
                <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 12 }}>
                  {Object.entries(conteggi)
                    .filter(([,cnt]) => cnt > 0)
                    .sort((a,b) => b[1]-a[1])
                    .map(([val], idx) => {
                      const noms = getNominativi(val)
                      const col = colori[idx % colori.length]
                      return (
                        <details key={val} style={{ marginBottom: 6 }}>
                          <summary style={{
                            cursor:'pointer', fontWeight:700, fontSize:'.83rem',
                            padding:'7px 12px', borderRadius:10, userSelect:'none',
                            display:'flex', alignItems:'center', gap:8,
                            background:'var(--bg)', listStyle:'none'
                          }}>
                            <span style={{ width:10,height:10,borderRadius:'50%',background:col,display:'inline-block',flexShrink:0 }} />
                            {val}
                            <span style={{ marginLeft:'auto', background:col, color:'#fff', borderRadius:20, padding:'2px 10px', fontSize:'.75rem', fontWeight:800 }}>
                              {noms.length}
                            </span>
                          </summary>
                          <div style={{ paddingLeft:10, paddingTop:8, display:'flex', flexWrap:'wrap', gap:6 }}>
                            {noms.map(i => (
                              <span key={i.id} style={{
                                background:'#fff', border:`1.5px solid ${col}`,
                                borderRadius:20, padding:'3px 12px',
                                fontSize:'.8rem', fontWeight:600, color:'var(--text)'
                              }}>
                                {i.nome_bambino} {i.cognome_bambino}
                              </span>
                            ))}
                          </div>
                        </details>
                      )
                    })
                  }
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* ── VISTA LISTA (originale con filtri aggiunti) ── */
        <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm btn-ghost" onClick={esportaCsv}>📥 Esporta CSV</button>
        <button className="btn btn-sm btn-ghost" onClick={() => stampaPDF(iscrizioni, evento)}
          title="Apri finestra di stampa PDF con lista iscritti">
          🖨️ Stampa PDF
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {iscrizioniOrd.filter(i => !i.saldato).length > 0 && (
            <span style={{
              background: '#fee2e2', color: '#c0392b',
              borderRadius: 20, padding: '4px 12px',
              fontWeight: 800, fontSize: '.78rem'
            }}>
              ⏳ {iscrizioniOrd.filter(i => !i.saldato).length} da saldare
            </span>
          )}
          <button
            onClick={() => setSoloDaSaldare(v => !v)}
            style={{
              border: '2px solid',
              borderColor: soloDaSaldare ? '#e65100' : 'var(--border)',
              background: soloDaSaldare ? '#fff3e0' : '#fff',
              color: soloDaSaldare ? '#e65100' : 'var(--text-muted)',
              borderRadius: 20, padding: '5px 14px',
              fontWeight: 700, fontSize: '.82rem', cursor: 'pointer'
            }}>
            {soloDaSaldare ? '✕ Rimuovi filtro' : '⏳ Da saldare'}
          </button>
        </div>
      </div>

      {/* Filtro per campo extra */}
      {tutteCategorie.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg)', borderRadius: 12 }}>
          <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-muted)' }}>🔖 Filtra per:</span>
          <select
            className="form-select"
            style={{ width: 'auto', padding: '5px 12px', fontSize: '.84rem' }}
            value={filtroCampo}
            onChange={e => { setFiltroCampo(e.target.value); setFiltroValore('') }}>
            <option value="">— Categoria —</option>
            {tutteCategorie.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {filtroCampo && (() => {
            const catSel = tutteCategorie.find(c => c.id === filtroCampo)
            const opzSel = catSel ? Object.entries(catSel.conteggi).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).map(([v])=>v) : []
            return (
              <select className="form-select" style={{ width: 'auto', padding: '5px 12px', fontSize: '.84rem' }}
                value={filtroValore} onChange={e => setFiltroValore(e.target.value)}>
                <option value="">— Tutte le opzioni —</option>
                {opzSel.map(o => <option key={o} value={o}>{o} ({catSel.conteggi[o]})</option>)}
              </select>
            )
          })()}
          {(filtroCampo || filtroValore) && (
            <button onClick={() => { setFiltroCampo(''); setFiltroValore('') }}
              style={{ border: 'none', background: 'none', color: 'var(--danger)', fontWeight: 700, cursor: 'pointer', fontSize: '.84rem' }}>
              ✕ Rimuovi
            </button>
          )}
          {filtroCampo && filtroValore && (
            <span style={{ marginLeft: 4, fontSize: '.8rem', color: 'var(--primary)', fontWeight: 700 }}>
              {iscrizioni.length} iscritti
            </span>
          )}
        </div>
      )}

      <div className="table-wrap"><table>
        <thead><tr>
          <th>Nome</th><th>Cognome</th><th>Nato il</th><th>Genitore</th>
          <th>Settimane</th><th>Servizi</th><th>Totale</th><th>Saldato</th>
          <th>🏷️</th>
          {campiExtra.map(campo => (
            <th key={campo.id}>{campo.label}</th>
          ))}
          <th>Username</th>
          <th></th>
        </tr></thead>
        <tbody>{iscrizioni.map(i => (
          <tr key={i.id}>
            <td><b>{i.nome_bambino}</b></td>
            <td>{i.cognome_bambino}</td>
            <td>{i.data_nascita}</td>
            <td><small>{i.email_genitore}<br />{i.telefono_genitore}</small></td>
            <td><small>{(i.settimane||[]).map(s=>`Sett.${s}`).join(', ')}</small></td>
            <td>
              <small>{(i.servizi||[]).join(', ')}</small>
              {(i.mensa_settimane||[]).length > 0 && (
                <span style={{ marginLeft: 4, fontSize: '.72rem', background: '#fff8e1', color: '#e65100', padding: '1px 6px', borderRadius: 999 }}>
                  🍽️ sett.{(i.mensa_settimane||[]).join(',')}
                </span>
              )}
            </td>
            <td><b style={{ color: 'var(--primary)' }}>{fmt(i.totale)}</b></td>
            <td style={{ textAlign: 'center' }}>
              <button
                onClick={async () => {
                  await supabase.from('iscrizioni').update({ saldato: !i.saldato }).eq('id', i.id)
                  logAudit({ user, azione: i.saldato ? 'SEGNA_NON_SALDATO' : 'SEGNA_SALDATO', categoria: 'Iscritti',
                    dettaglio: `${i.nome_bambino} ${i.cognome_bambino} segnato come ${i.saldato ? 'NON saldato' : 'saldato'}`,
                    meta: { iscrizione_id: i.id, nome_bambino: i.nome_bambino, evento_id: evento.id } })
                  onReload()
                }}
                style={{
                  background: i.saldato ? '#27ae60' : '#fee2e2',
                  color: i.saldato ? '#fff' : '#c0392b',
                  border: 'none', borderRadius: 20, padding: '4px 12px',
                  fontWeight: 800, fontSize: '.78rem', cursor: 'pointer', whiteSpace: 'nowrap'
                }}
                title={i.saldato ? 'Clicca per segnare come non saldato' : 'Clicca per segnare come saldato'}>
                {i.saldato ? '✅ Saldato' : '⏳ Da saldare'}
              </button>
            </td>
            <td>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', maxWidth: 140 }}>
                {(i.tags || []).map(t => (
                  <span key={t.label} style={{
                    background: t.color + '22', color: t.color,
                    border: `1.5px solid ${t.color}`,
                    borderRadius: 20, padding: '1px 7px',
                    fontSize: '.68rem', fontWeight: 700, whiteSpace: 'nowrap',
                  }}>{t.label}</span>
                ))}
                <button className="btn btn-sm btn-ghost" style={{ padding: '2px 6px', fontSize: '.72rem' }}
                  title="Gestisci etichette" onClick={() => setTagModal(i)}>
                  {(i.tags||[]).length > 0 ? '✏️' : '＋'}
                </button>
              </div>
            </td>
            {campiExtra.map(campo => {
              const valore = (i.dati_extra || {})[campo.id];
              let testoVisualizzato;
              if (campo.tipo === 'checkbox') {
                testoVisualizzato = valore ? 'Sì' : 'No';
              } else {
                testoVisualizzato = String(valore ?? '—');
              }
              return (
                <td key={campo.id}>
                  <small>{testoVisualizzato}</small>
                </td>
              );
            })}
            <td style={{ textAlign: 'center' }}>
              {i.username_genitore
                ? <code style={{ background: 'var(--secondary-pale)', color: '#1a6b66',
                    padding: '3px 8px', borderRadius: 6, fontSize: '.8rem',
                    fontWeight: 800, letterSpacing: .5 }}>{i.username_genitore}</code>
                : <span style={{ color: 'var(--text-muted)', fontSize: '.78rem' }}>—</span>
              }
            </td>

            <td style={{ whiteSpace: 'nowrap' }}>
              <div style={{ display: 'flex', gap: 4 }}>

                {i.username_genitore && (
                  <button className="btn btn-sm btn-ghost" title="Stampa foglietto credenziali"
                    onClick={() => setQrModal(i)}>📲</button>
                )}

                <button className="btn btn-sm btn-ghost" title="Stampa scheda iscrizione"
                  onClick={() => stampaScheda(i)}>🖨️</button>
                <button className="btn btn-sm btn-ghost" title="Modifica dati" onClick={() => apriModifica(i)}>✏️</button>
                <button className="btn btn-sm btn-ghost" title="Reset password genitore"
                  onClick={() => { setResetModal(i); setResetLink('') }}>🔑</button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(i.id)}>🗑️</button>
              </div>
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {/* Modal TAG / ETICHETTE ISCRITTO */}
      {tagModal && (
        <TagModal
          iscrizione={tagModal}
          evento={evento}
          user={user}
          onClose={() => { setTagModal(null); onReload() }}
        />
      )}

      {/* Modal RESET PASSWORD GENITORE */}
      {resetModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setResetModal(null)}>
          <div className="modal" style={{ maxWidth: 500 }}>
            <div className="modal-title">🔑 Reset password — {resetModal.nome_bambino} {resetModal.cognome_bambino}</div>

            {!resetLink ? (
              <>
                <div className="alert alert-info" style={{ marginBottom: 16 }}>
                  Genera un link di reset valido <b>24 ore</b>. Il genitore clicca il link
                  e sceglie una nuova password. Il link funziona una sola volta.
                </div>
                <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginBottom: 16 }}>
                  <div style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                    📧 Email genitore
                  </div>
                  {resetModal.email_genitore ? (
                    <code style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--primary)',
                      background: 'var(--primary-pale)', padding: '4px 12px', borderRadius: 8 }}>
                      {resetModal.email_genitore}
                    </code>
                  ) : (
                    <div style={{ fontSize: '.78rem', color: 'var(--danger)', marginTop: 4 }}>
                      ⚠️ Nessuna email registrata — impossibile inviare il reset.
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '.83rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                  Il link generato verrà copiato — invialoo manualmente al genitore.
                </div>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => setResetModal(null)}>Annulla</button>
                  <button className="btn btn-primary" onClick={() => generaLinkReset(resetModal)}
                    disabled={resetSaving || !resetModal.email_genitore}>
                    {resetSaving
                      ? <><span className="spinner" /> Generazione...</>
                      : '🔑 Genera link di reset'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="alert alert-success" style={{ marginBottom: 16 }}>
                  ✅ Link generato! Valido per <b>24 ore</b>. Invialo al genitore via WhatsApp o email.
                </div>
                <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
                  <div style={{ fontSize: '.75rem', color: 'var(--text-muted)', marginBottom: 6, fontWeight: 700 }}>
                    🔗 Link di reset
                  </div>
                  <div style={{
                    wordBreak: 'break-all', fontSize: '.8rem', color: 'var(--primary)',
                    background: 'var(--primary-pale)', padding: '10px 12px', borderRadius: 8,
                    fontFamily: 'monospace', lineHeight: 1.6,
                  }}>
                    {resetLink}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                  <button className="btn btn-primary" onClick={() => {
                    navigator.clipboard?.writeText(resetLink)
                      .then(() => alert('✅ Link copiato negli appunti!'))
                      .catch(() => {})
                  }}>
                    📋 Copia link
                  </button>
                  {resetModal.email_genitore && (
                    <button className="btn btn-ghost" onClick={() => {
                      const sogg = encodeURIComponent('[Oratorio Sergnano] Reimposta la tua password')
                      const corpo = encodeURIComponent(
`Gentile genitore di ${resetModal.nome_bambino} ${resetModal.cognome_bambino},

Clicca il link qui sotto per impostare una nuova password (valido 24 ore):

${resetLink}

Se non hai richiesto questa operazione, ignora questa email.

Oratorio di Sergnano`)
                      window.open(`mailto:${resetModal.email_genitore}?subject=${sogg}&body=${corpo}`)
                    }}>
                      📧 Apri email
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={() => {
                    const testo = `Ciao! Clicca qui per impostare una nuova password per l'Area dell'Oratorio di Sergnano (valido 24 ore):
${resetLink}`
                    navigator.clipboard?.writeText(testo)
                      .then(() => alert('✅ Messaggio WhatsApp copiato! Incollalo in WhatsApp.'))
                      .catch(() => {})
                  }}>
                    💬 Copia per WhatsApp
                  </button>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => { setResetModal(null); setResetLink('') }}>
                    Chiudi
                  </button>
                  <button className="btn btn-ghost" onClick={() => setResetLink('')}>
                    🔄 Genera nuovo link
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal QR CODE + foglietto credenziali */}
      {qrModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setQrModal(null)}>
          <div className="modal" style={{ maxWidth: 460, textAlign: 'center' }}>
            <div className="modal-title" style={{ textAlign: 'left' }}>
              📲 Foglietto credenziali — {qrModal.nome_bambino} {qrModal.cognome_bambino}
            </div>
            {!qrModal.username_genitore ? (
              <div className="alert alert-warn" style={{ textAlign: 'left', marginBottom: 16 }}>
                ⚠️ Questo iscritto non ha ancora impostato le credenziali di accesso.
                Le credenziali vengono create al momento dell'iscrizione online.
              </div>
            ) : (
              <div className="alert alert-info" style={{ textAlign: 'left', marginBottom: 16, fontSize: '.83rem' }}>
                Stampa e consegna questo foglietto al genitore. Il QR apre l'Area Genitori,
                lo spazio bianco è per annotare la password a mano.
              </div>
            )}
            <QrCodeDisplay
              username={qrModal.username_genitore}
              nomeBambino={`${qrModal.nome_bambino} ${qrModal.cognome_bambino}`}
              evento={evento.nome}
            />
            <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setQrModal(null)}>Chiudi</button>
              <button className="btn btn-primary" onClick={() => {
                const el = document.getElementById('qr-print-area')
                if (!el) return
                const w = window.open('', '_blank')
                w.document.write(`<!DOCTYPE html><html lang="it"><head>
                  <meta charset="UTF-8">
                  <title>Credenziali — ${qrModal.nome_bambino} ${qrModal.cognome_bambino}</title>
                  <style>
                    @page { margin: 15mm; size: A6; }
                    body { font-family: Arial, sans-serif; text-align: center; padding: 10px; }
                    @media print { button { display: none !important; } }
                  </style>
                </head><body>
                  <img src="/logo-oratorio.png" style="width:60px;margin-bottom:8px"
                    onerror="this.style.display='none'">
                  <h3 style="margin:0 0 4px;font-size:14px">Oratorio di Sergnano</h3>
                  <p style="margin:0 0 12px;font-size:11px;color:#888">Area Genitori — Credenziali di accesso</p>
                  ${el.innerHTML}
                  <p style="margin-top:14px;font-size:10px;color:#aaa">
                    Conserva questo foglietto in un posto sicuro
                  </p>
                </body></html>`)
                w.document.close()
                setTimeout(() => w.print(), 400)
              }}>
                🖨️ Stampa foglietto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal MODIFICA ISCRITTO */}
      {modalEdit && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModalEdit(null)}>
          <div className="modal" style={{ maxWidth: 600 }}>
            <div className="modal-title">✏️ Modifica — {modalEdit.nome_bambino} {modalEdit.cognome_bambino}</div>
            <div className="tabs" style={{ marginBottom: 20 }}>
              {['bambino','genitore','extra'].map(t => {
                const labels = { bambino: '👦 Bambino', genitore: '👨‍👩‍👧 Genitore', extra: '📋 Extra' }
                return (
                  <div key={t} className={`tab ${(editForm._tab||'bambino') === t ? 'active' : ''}`}
                    onClick={() => setEditForm(p => ({...p, _tab: t}))}>
                    {labels[t]}
                  </div>
                )
              })}
            </div>

            {(editForm._tab || 'bambino') === 'bambino' && (
              <div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Nome *</label>
                    <input className="form-input" value={editForm.nome_bambino || ''}
                      onChange={e => setEditForm(p => ({...p, nome_bambino: e.target.value}))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cognome *</label>
                    <input className="form-input" value={editForm.cognome_bambino || ''}
                      onChange={e => setEditForm(p => ({...p, cognome_bambino: e.target.value}))} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Data di nascita</label>
                    <input className="form-input" type="date" value={editForm.data_nascita || ''}
                      onChange={e => setEditForm(p => ({...p, data_nascita: e.target.value}))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Comune di residenza</label>
                    <input className="form-input" value={editForm.comune_residenza || ''}
                      onChange={e => setEditForm(p => ({...p, comune_residenza: e.target.value}))} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Note</label>
                  <textarea className="form-textarea" rows={2} value={editForm.note || ''}
                    onChange={e => setEditForm(p => ({...p, note: e.target.value}))} />
                </div>
              </div>
            )}

            {(editForm._tab || 'bambino') === 'genitore' && (
              <div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Nome genitore</label>
                    <input className="form-input" value={editForm.nome_genitore || ''}
                      onChange={e => setEditForm(p => ({...p, nome_genitore: e.target.value}))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cognome genitore</label>
                    <input className="form-input" value={editForm.cognome_genitore || ''}
                      onChange={e => setEditForm(p => ({...p, cognome_genitore: e.target.value}))} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Email</label>
                    <input className="form-input" type="email" value={editForm.email_genitore || ''}
                      onChange={e => setEditForm(p => ({...p, email_genitore: e.target.value}))} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Telefono</label>
                    <input className="form-input" type="tel" value={editForm.telefono_genitore || ''}
                      onChange={e => setEditForm(p => ({...p, telefono_genitore: e.target.value}))} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Metodo di pagamento</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(evento.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).map(m => (
                      <button key={m} type="button"
                        className={`btn btn-sm ${editForm.metodo_pagamento === m ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setEditForm(p => ({...p, metodo_pagamento: m}))}>
                        {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {(editForm._tab || 'bambino') === 'extra' && (
              <div>
                {campiExtra.length === 0
                  ? <div className="alert alert-info">Nessun campo extra configurato per questo evento.</div>
                  : campiExtra.map(c => (
                    <div key={c.id} className="form-group">
                      <label className="form-label">{c.label}</label>
                      {c.tipo === 'select'
                        ? <select className="form-select" value={(editForm.dati_extra||{})[c.id] || ''}
                            onChange={e => setEditForm(p => ({...p, dati_extra: {...(p.dati_extra||{}), [c.id]: e.target.value}}))}>
                            <option value="">— Seleziona —</option>
                            {(c.opzioni||'').split('\n').map(o=>o.trim()).filter(Boolean).map(o=>
                              <option key={o} value={o}>{o}</option>
                            )}
                          </select>
                        : c.tipo === 'checkbox'
                        ? <label className={`check-item ${(editForm.dati_extra||{})[c.id] ? 'checked' : ''}`}>
                            <input type="checkbox" checked={!!((editForm.dati_extra||{})[c.id])}
                              onChange={e => setEditForm(p => ({...p, dati_extra: {...(p.dati_extra||{}), [c.id]: e.target.checked}}))} />
                            <span>{c.label}</span>
                          </label>
                        : <input className="form-input" value={(editForm.dati_extra||{})[c.id] || ''}
                            onChange={e => setEditForm(p => ({...p, dati_extra: {...(p.dati_extra||{}), [c.id]: e.target.value}}))} />
                      }
                    </div>
                  ))
                }
              </div>
            )}

            <div className="modal-footer">
              <button className="btn btn-ghost btn-sm"
                style={{ marginRight: 'auto', color: '#e65100' }}
                title="Collega fratelli/sorelle"
                onClick={() => { setModalEdit(null); apriModalFam(modalEdit) }}>
                👨‍👩‍👦 Collega fratelli
              </button>
              <button className="btn btn-ghost" onClick={() => setModalEdit(null)}>Annulla</button>
              <button className="btn btn-primary" onClick={salvaModifica} disabled={editSaving}>
                {editSaving ? <><span className="spinner" /> Salvataggio...</> : '💾 Salva modifiche'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal unione fratelli */}
      {modalFam && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModalFam(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-title">👨‍👩‍👦 Unisci fratelli — {modalFam.nome_bambino} {modalFam.cognome_bambino}</div>

            {famMsg
              ? <div className="alert alert-success">{famMsg}</div>
              : <>
                  <div className="alert alert-info" style={{ fontSize: '.83rem', marginBottom: 14 }}>
                    Seleziona i fratelli/sorelle da collegare. Il genitore potrà accedere all'area personale con un unico codice e vedere tutti i figli insieme.
                  </div>

                  {/* Lista altri iscritti da spuntare */}
                  <div className="form-group">
                    <label className="form-label">Seleziona i fratelli di {modalFam.nome_bambino}:</label>
                    {iscrizioni.filter(x => x.id !== modalFam.id).length === 0
                      ? <div className="alert alert-warn">Nessun altro iscritto in questo evento.</div>
                      : <div style={{ maxHeight: 220, overflowY: 'auto', border: '1.5px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                          {iscrizioni.filter(x => x.id !== modalFam.id).map(x => (
                            <label key={x.id} className={`check-item ${famSelezionati.includes(x.id) ? 'checked' : ''}`} style={{ marginBottom: 6 }}>
                              <input type="checkbox"
                                checked={famSelezionati.includes(x.id)}
                                onChange={() => setFamSelezionati(p =>
                                  p.includes(x.id) ? p.filter(id => id !== x.id) : [...p, x.id]
                                )} />
                              <span>
                                <b>{x.nome_bambino} {x.cognome_bambino}</b>
                                <small style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                                  {x.username_genitore
                                    ? <code style={{ background: 'var(--secondary-pale)', color: '#1a6b66',
                                        padding: '1px 6px', borderRadius: 4, fontSize: '.75rem' }}>
                                        @{x.username_genitore}
                                      </code>
                                    : <span style={{ color: 'var(--danger)' }}>⚠️ no credenziali</span>
                                  }
                                  {x.email_genitore && <span style={{ marginLeft: 6 }}>{x.email_genitore}</span>}
                                  {x.codice_famiglia && <span style={{ color: '#e65100', marginLeft: 6 }}>già in famiglia</span>}
                                </small>
                              </span>
                            </label>
                          ))}
                        </div>
                    }
                  </div>

                  {modalFam.codice_famiglia && (
                    <div style={{ marginBottom: 12 }}>
                      <span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>
                        Famiglia collegata — codice interno:{' '}
                      </span>
                      <code style={{ background: '#fff8e1', color: '#e65100',
                        padding: '2px 8px', borderRadius: 6, fontWeight: 800,
                        fontSize: '.78rem' }}>
                        {modalFam.codice_famiglia}
                      </code>
                    </div>
                  )}

                  <div className="modal-footer">
                    {modalFam.codice_famiglia && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={rimuoviFamiglia}>
                        ✂️ Scollega
                      </button>
                    )}
                    <button className="btn btn-ghost" onClick={() => setModalFam(null)}>Annulla</button>
                    <button className="btn btn-primary" onClick={salvaFamiglia} disabled={famSaving}>
                      {famSaving ? <><span className="spinner" /> Salvataggio...</> : `👨‍👩‍👦 Collega ${famSelezionati.length > 0 ? famSelezionati.length + ' fratell' + (famSelezionati.length === 1 ? 'o' : 'i') : 'famiglia'}`}
                    </button>
                  </div>
                </>
            }
          </div>
        </div>
      )}

      {/* Pannello dettaglio campi extra */}
      {dettaglio && (
        <div style={{ marginTop: 16, background: 'var(--primary-pale)', border: '2px solid var(--primary)', borderRadius: 12, padding: 18 }}>
          <div style={{ fontWeight: 800, marginBottom: 12, color: 'var(--primary)' }}>
            📋 Dati extra — {dettaglio.nome_bambino} {dettaglio.cognome_bambino}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {campiExtra.map(c => {
              const valore = (dettaglio.dati_extra || {})[c.id];
              let testoVisualizzato;
              if (c.tipo === 'checkbox') {
                testoVisualizzato = valore ? 'Sì' : 'No';
              } else {
                testoVisualizzato = String(valore ?? '—');
              }
              return (
                <div key={c.id} style={{ background: '#fff', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ fontSize: '.75rem', color: 'var(--text-muted)', fontWeight: 700 }}>{c.label}</div>
                  <div style={{ fontWeight: 600 }}>
                    {testoVisualizzato}
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn btn-sm btn-ghost" style={{ marginTop: 10 }} onClick={() => setDettaglio(null)}>✕ Chiudi</button>
        </div>
      )}
    </div>
      )}
    </div>
  )
}

function TabPresenze({ iscrizioni, evento }) {
  const [modalita, setModalita] = useState('settimane')
  const [presenze, setPresenze] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('presenze').select('*').eq('evento_id', evento.id).then(({ data }) => {
      const map = {}
      ;(data || []).forEach(p => {
        if (!map[p.iscrizione_id]) map[p.iscrizione_id] = {}
        map[p.iscrizione_id][p.data_o_settimana] = p.stato
      })
      setPresenze(map)
      setLoading(false)
    })
  }, [evento.id])

  const togglePresenza = async (iscrizioneId, chiave, statoCorrente) => {
    const nuovo = statoCorrente === 'P' ? 'A' : statoCorrente === 'A' ? null : 'P'
    setPresenze(p => ({ ...p, [iscrizioneId]: { ...(p[iscrizioneId] || {}), [chiave]: nuovo } }))
    if (nuovo === null) {
      await supabase.from('presenze').delete().eq('iscrizione_id', iscrizioneId).eq('data_o_settimana', chiave)
    } else {
      await supabase.from('presenze').upsert({ iscrizione_id: iscrizioneId, evento_id: evento.id, data_o_settimana: chiave, stato: nuovo }, { onConflict: 'iscrizione_id,data_o_settimana' })
    }
  }

  if (iscrizioni.length === 0) return <div className="alert alert-info">Nessun iscritto.</div>
  if (loading) return <LoadingPage text="Caricamento presenze..." />

  const unita = modalita === 'settimane'
    ? getWeeksInRange(evento.data_inizio, evento.data_fine)
    : getDaysInRange(evento.data_inizio, evento.data_fine)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${modalita === 'settimane' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setModalita('settimane')}>Per Settimane</button>
        <button className={`btn btn-sm ${modalita === 'giorni' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setModalita('giorni')}>Per Giorni</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            <th>Nominativo</th>
            {unita.map((u, i) => <th key={i} style={{ minWidth: 80, fontSize: '.72rem' }}>
              {typeof u === 'string' ? new Date(u).toLocaleDateString('it', { day: 'numeric', month: 'short' }) : u.label}
            </th>)}
          </tr></thead>
          <tbody>{iscrizioni.map(iscr => (
            <tr key={iscr.id}>
              <td><b>{iscr.nome_bambino} {iscr.cognome_bambino}</b></td>
              {unita.map((u, i) => {
                const key = typeof u === 'string' ? u : u.id
                const val = presenze[iscr.id]?.[key]
                return <td key={i} style={{ textAlign: 'center' }}>
                  <button className={`presenza-btn ${val === 'P' ? 'p' : val === 'A' ? 'a' : 'empty'}`}
                    onClick={() => togglePresenza(iscr.id, key, val)}>
                    {val || '–'}
                  </button>
                </td>
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="alert alert-info" style={{ marginTop: 12 }}>
        Clicca: vuoto → <b>P</b> (presente) → <b>A</b> (assente) → vuoto
      </div>
    </div>
  )
}

function TabReport({ iscrizioni, evento, incasso }) {
  const settimaneConti = {}
  iscrizioni.forEach(i => (i.settimane || []).forEach(s => { settimaneConti[s] = (settimaneConti[s] || 0) + 1 }))
  const serviziConti = {}
  iscrizioni.forEach(i => (i.servizi || []).forEach(s => { serviziConti[s] = (serviziConti[s] || 0) + 1 }))
  return (
    <div>
      <div className="grid-3">
        <div className="stat-card"><div className="stat-value">{iscrizioni.length}</div><div className="stat-label">Iscritti totali</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: 'var(--accent)' }}>{fmt(incasso)}</div><div className="stat-label">Incasso totale</div></div>
        <div className="stat-card"><div className="stat-value">{iscrizioni.length > 0 ? fmt(incasso / iscrizioni.length) : '€0'}</div><div className="stat-label">Media per iscritto</div></div>
      </div>
      {Object.keys(settimaneConti).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Iscrizioni per settimana</div>
          {Object.entries(settimaneConti).map(([s, n]) => (
            <div key={s} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span>Settimana {s}</span><b>{n} bambini</b>
            </div>
          ))}
        </div>
      )}
      {Object.keys(serviziConti).length > 0 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>Servizi richiesti</div>
          {Object.entries(serviziConti).map(([s, n]) => (
            <div key={s} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{s}</span><b>{n} richieste</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── TAB APPELLO GIORNALIERO ─────────────────────────────────────────────────
function TabAppello({ iscrizioni, evento, user }) {
  const days = getDaysInRange(evento.data_inizio, evento.data_fine)
  
  // Imposta il giorno predefinito: oggi se siamo nel range, altrimenti il primo giorno
  const getInitialDay = () => {
    const t = today()
    if (days.includes(t)) return t
    // Se oggi è prima dell'evento, usa il primo giorno
    if (t < days[0]) return days[0]
    // Se oggi è dopo l'evento, usa l'ultimo giorno
    return days[days.length - 1]
  }

  const [selectedDay, setSelectedDay] = useState(getInitialDay())
  const [searchTerm,  setSearchTerm]  = useState('')
  // appello[id] = { pranzo: 'casa'|'sacco'|'mensa'|null }
  // presenza = automatica: se pranzo è valorizzato → P, altrimenti assente
  const [appello, setAppello] = useState({})
  const [buoni,   setBuoni]   = useState({})
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)

  const mensaIds     = (evento.servizi || []).filter(s => s.nome?.toLowerCase().includes('mensa')).map(s => s.id)
  const mensaServizio = (evento.servizi || []).find(s => s.nome?.toLowerCase().includes('mensa'))
  const settimaneEvento = getWeeksInRange(evento.data_inizio, evento.data_fine)

  // Ritorna l'id-settimana (es. "1","2",...) a cui appartiene una data
  const settimanaPerData = (dataStr) => {
    const d = new Date(dataStr + 'T12:00:00')
    const found = settimaneEvento.find(s => {
      const st = new Date(s.start + 'T00:00:00')
      const en = new Date(s.end + 'T23:59:59')
      return d >= st && d <= en
    })
    return found?.id || null
  }

  // Un bambino ha mensa nella settimana del giorno selezionato?
  const bambinoPuoUsareMensa = (iscrizione) => {
    if (!mensaServizio) return false // nessun servizio mensa nell'evento
    const sidSettimana = settimanaPerData(selectedDay)
    if (!sidSettimana) return false
    // mensa_settimane è array di id-settimana (es. ["1","3"])
    const menseSett = iscrizione.mensa_settimane || []
    return menseSett.includes(sidSettimana)
  }

  useEffect(() => {
    if (!selectedDay) return
    setLoading(true)
    Promise.all([
      supabase.from('appello_giornaliero').select('*').eq('evento_id', evento.id).eq('data', selectedDay),
      supabase.from('buoni_pasto').select('*').eq('evento_id', evento.id),
    ]).then(([{ data: app }, { data: bp }]) => {
      const mapApp = {}
      ;(app || []).forEach(r => { mapApp[r.iscrizione_id] = { pranzo: r.pranzo } })
      setAppello(mapApp)
      const mapBp = {}
      ;(bp || []).forEach(r => { mapBp[r.iscrizione_id] = r.quantita })
      setBuoni(mapBp)
      setLoading(false)
    })
  }, [selectedDay, evento.id])

  // Seleziona/deseleziona pranzo — presenza è automatica se pranzo è valorizzato
  const setPranzo = (iscId, val) => {
    setAppello(p => ({
      ...p,
      [iscId]: { pranzo: (p[iscId]?.pranzo === val) ? null : val }
    }))
  }

  const setTuttiPresenti = (tipo) => {
    const newAppello = { ...appello }
    iscrizioni.forEach(i => {
      if (!newAppello[i.id]?.pranzo) {
        if (tipo === 'mensa' && !bambinoPuoUsareMensa(i)) return
        newAppello[i.id] = { pranzo: tipo }
      }
    })
    setAppello(newAppello)
  }

  const svuotaAppello = () => {
    if (window.confirm('Svuotare l\'appello corrente?')) {
      setAppello({})
    }
  }

  const salva = async () => {
    if (!window.confirm(`Salvare l'appello e inviare le notifiche push ai genitori per il giorno ${selectedDay}?`)) return
    setSaving(true)

    const righeAppello = iscrizioni.map(i => {
      const pranzo = appello[i.id]?.pranzo || null
      return { iscrizione_id: i.id, pranzo }
    }).filter(r => r.pranzo)

    // CHIAMATA SINGOLA OTTIMIZZATA AL DATABASE via RPC
    const { error: rpcErr } = await supabase.rpc('salva_appello_ottimizzato', {
      p_evento_id: evento.id,
      p_data:      selectedDay,
      p_righe:     righeAppello
    })

    if (rpcErr) {
      console.error('Errore RPC appello:', rpcErr.message)
      alert('Errore nel salvataggio dell\'appello. Riprova.')
      setSaving(false)
      return
    }

    // Ricarichiamo i buoni aggiornati dal DB (poiché la RPC ha scalato i buoni)
    const { data: nuoviBuoniData } = await supabase.from('buoni_pasto').select('*').eq('evento_id', evento.id)
    const mapBp = {}
    ;(nuoviBuoniData || []).forEach(r => { mapBp[r.iscrizione_id] = r.quantita })
    setBuoni(mapBp)

    // Notifiche push ai genitori: presenza dettagliata
    for (const i of iscrizioni) {
      const pranzo = appello[i.id]?.pranzo
      const codice = i.codice_accesso || i.codice_famiglia
      if (!pranzo || !codice) continue

      const dataLeggibile = new Date(selectedDay + 'T12:00:00')
        .toLocaleDateString('it', { weekday: 'long', day: 'numeric', month: 'long' })

      let titolo, corpo
      const buoniDopoScala = mapBp[i.id] ?? 0

      if (pranzo === 'mensa') {
        titolo = `🍽️ ${i.nome_bambino} — ${dataLeggibile}`
        if (buoniDopoScala >= 0) {
          corpo  = `✅ Presente · Mensa · Buono scalato · Buoni rimasti: ${buoniDopoScala}`
        } else {
          corpo  = `⚠️ Presente · Mensa · Credito insufficiente (${buoniDopoScala}) · Si prega di ricaricare`
        }
      } else if (pranzo === 'sacco') {
        titolo = `🎒 ${i.nome_bambino} — ${dataLeggibile}`
        corpo  = `✅ Presente · Pranzo al sacco`
      } else {
        titolo = `🏠 ${i.nome_bambino} — ${dataLeggibile}`
        corpo  = `✅ Presente · Pranzo a casa`
      }

      sendPushNotification({ 
        titolo, 
        corpo, 
        target_tipo: 'genitore', 
        target_ids: [codice],
        url: '/area-personale' 
      })
    }

    const presentiCount = righeAppello.length
    logAudit({ user, azione: 'SALVA_APPELLO', categoria: 'Appello',
      dettaglio: `Appello del ${selectedDay}: ${presentiCount} presenti su ${iscrizioni.length} (${evento.nome})`,
      meta: { evento_id: evento.id, evento_nome: evento.nome, data: selectedDay,
        presenti: presentiCount, totale: iscrizioni.length } })
    setSaving(false)
    alert('✅ Appello salvato istantaneamente e notifiche inviate!')
  }

  // ── Export Excel multi-foglio (CSV multi-sezione) ──────────────────────────
  const esportaExcel = () => {
    const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('it', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    const rows = iscrizioniAlf.map(i => ({
      bambino: `${i.nome_bambino} ${i.cognome_bambino}`,
      pranzo:  appello[i.id]?.pranzo || null,
      buoni:   buoni[i.id] ?? 0,
    }))

    const presenti  = rows.filter(r => r.pranzo)
    const casa      = rows.filter(r => r.pranzo === 'casa')
    const sacco     = rows.filter(r => r.pranzo === 'sacco')
    const mensa     = rows.filter(r => r.pranzo === 'mensa')
    const assenti   = rows.filter(r => !r.pranzo)

    const sezione = (titolo, lista, colonna) => {
      const hdr = `"${titolo}"`
      const sub = lista.length === 0
        ? ['"Nessuno"']
        : lista.map((r, idx) => `"${idx+1}","${r.bambino}"${colonna === 'buoni' ? `,"${r.buoni} buoni"` : ''}`)
      const footer = `"Totale: ${lista.length}"`
      return [hdr, ...sub, footer, ''].join('')
    }

    const csvContent =
      `"APPELLO GIORNALIERO — ${evento.nome}"
` +
      `"Data: ${fmtDay(selectedDay)}"

` +
      sezione('✅ PRESENTI TOTALI', presenti, '') +
      sezione('🏠 PRANZO A CASA', casa, '') +
      sezione('🎒 PRANZO AL SACCO', sacco, '') +
      sezione('🍽️ MENSA', mensa, 'buoni') +
      sezione('❌ ASSENTI (non segnati)', assenti, '') +
      `
"RIEPILOGO CONTEGGI"
` +
      `"Tipo","Conteggio"
` +
      `"Presenti totali","${presenti.length}"
` +
      `"Pranzo casa","${casa.length}"
` +
      `"Pranzo sacco","${sacco.length}"
` +
      `"Mensa","${mensa.length}"
` +
      `"Assenti","${assenti.length}"
` +
      `"Totale iscritti","${rows.length}"
`

    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `appello_${evento.nome.replace(/\s+/g,'_')}_${selectedDay}.csv`
    a.click()
  }

  // ── Conteggi live ──────────────────────────────────────────────────────────
  // Ordine alfabetico per cognome poi nome
  const iscrizioniAlf = [...iscrizioni].sort((a, b) =>
    (a.cognome_bambino || '').localeCompare(b.cognome_bambino || '', 'it') ||
    (a.nome_bambino    || '').localeCompare(b.nome_bambino    || '', 'it')
  )

  const countPranzo = (tipo) => iscrizioni.filter(i => appello[i.id]?.pranzo === tipo).length
  const totPresenti = iscrizioni.filter(i => appello[i.id]?.pranzo).length

  const iscrittiFiltrati = iscrizioniAlf.filter(i => 
    `${i.nome_bambino} ${i.cognome_bambino}`.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (iscrizioni.length === 0) return <div className="alert alert-info">Nessun iscritto.</div>

  return (
    <div>
      {/* Header: selezione giorno + azioni */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 200px' }}>
            <label className="form-label">📅 Giorno appello</label>
            <select className="form-select" value={selectedDay} onChange={e => setSelectedDay(e.target.value)}>
              {days.map(d => (
                <option key={d} value={d}>
                  {new Date(d + 'T12:00:00').toLocaleDateString('it', { weekday: 'long', day: 'numeric', month: 'long' })}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: '2 1 300px' }}>
            <label className="form-label">🔍 Cerca bambino</label>
            <input 
              className="form-input" 
              placeholder="Nome o cognome..." 
              value={searchTerm} 
              onChange={e => setSearchTerm(e.target.value)} 
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={salva} disabled={saving}>
              {saving ? <><span className="spinner" /> Salvo...</> : '💾 Salva e Invia'}
            </button>
            <button className="btn btn-ghost" onClick={esportaExcel} title="Scarica CSV">
              📥 Export
            </button>
          </div>
        </div>
      </div>

      {/* Azioni rapide + Contatori */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '1 1 300px', marginBottom: 0, padding: 16 }}>
          <div style={{ fontSize: '.75rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12, letterSpacing: 1 }}>
            ⚡ Azioni Rapide (per i vuoti)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => setTuttiPresenti('casa')}>🏠 Tutti a Casa</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setTuttiPresenti('sacco')}>🎒 Tutti al Sacco</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setTuttiPresenti('mensa')}>🍽️ Tutti a Mensa</button>
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={svuotaAppello}>🗑️ Svuota</button>
          </div>
        </div>

        <div style={{ flex: '2 1 400px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            { label: 'Presenti', val: totPresenti, color: 'var(--green)' },
            { label: 'Casa', val: countPranzo('casa'), color: '#6c5ce7' },
            { label: 'Sacco', val: countPranzo('sacco'), color: 'var(--accent)' },
            { label: 'Mensa', val: countPranzo('mensa'), color: 'var(--primary)' },
          ].map(c => (
            <div key={c.label} style={{ background: '#fff', border: '1.5px solid var(--border)', borderRadius: 12, padding: '10px', textAlign: 'center', boxShadow: 'var(--shadow)' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 900, color: c.color, lineHeight: 1 }}>{c.val}</div>
              <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginTop: 4 }}>{c.label}</div>
            </div>
          ))}
        </div>
      </div>

      {loading ? <LoadingPage text="Caricamento..." /> : (
        <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
          <table style={{ background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow)' }}>
            <thead>
              <tr style={{ background: 'var(--bg)' }}>
                <th style={{ width: 40 }}>#</th>
                <th>Bambino</th>
                <th style={{ textAlign: 'center', width: 220 }}>Scelta Pranzo</th>
                <th style={{ textAlign: 'center', width: 100 }}>Stato</th>
                <th style={{ textAlign: 'center', width: 80 }}>Buoni</th>
              </tr>
            </thead>
            <tbody>
              {iscrittiFiltrati.map((i, idx) => {
                const pranzo = appello[i.id]?.pranzo || null
                const presente = !!pranzo
                const bp = buoni[i.id] ?? '—'
                const puoUsareMensa = bambinoPuoUsareMensa(i)
                
                return (
                  <tr key={i.id} style={{ 
                    borderBottom: '1px solid var(--border-light)',
                    background: presente ? 'rgba(173, 200, 101, 0.05)' : 'transparent'
                  }}>
                    <td style={{ color: 'var(--text-muted)', fontSize: '.75rem' }}>{idx + 1}</td>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: '.92rem' }}>{i.nome_bambino} {i.cognome_bambino}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        {!presente && <span className="badge" style={{ background: '#f3f4f6', color: '#6b7280', fontSize: '.6rem' }}>Assente</span>}
                        {puoUsareMensa && <span className="badge" style={{ background: '#fff8e1', color: '#e65100', fontSize: '.6rem' }}>Mensa ✓</span>}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                        {[
                          { id: 'casa', icon: '🏠', label: 'Casa', color: '#6c5ce7' },
                          { id: 'sacco', icon: '🎒', label: 'Sacco', color: 'var(--accent)' },
                          { id: 'mensa', icon: '🍽️', label: 'Mensa', color: 'var(--primary)' }
                        ].map(t => {
                          const disabled = t.id === 'mensa' && !puoUsareMensa
                          const active = pranzo === t.id
                          return (
                            <button
                              key={t.id}
                              type="button"
                              disabled={disabled}
                              onClick={() => setPranzo(i.id, t.id)}
                              style={{
                                flex: 1, padding: '8px 4px', borderRadius: 10, border: '2px solid',
                                fontSize: '.75rem', fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
                                transition: 'all .15s',
                                borderColor: disabled ? '#f3f4f6' : active ? t.color : 'var(--border-light)',
                                background: disabled ? '#f9fafb' : active ? t.color : '#fff',
                                color: disabled ? '#d1d5db' : active ? '#fff' : 'var(--text-muted)',
                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
                              }}
                            >
                              <span style={{ fontSize: '1.1rem' }}>{disabled ? '🚫' : t.icon}</span>
                              <span style={{ fontSize: '.6rem', textTransform: 'uppercase' }}>{t.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '4px 12px', borderRadius: 99, fontSize: '.75rem', fontWeight: 800,
                        background: presente ? 'var(--green-pale)' : 'var(--danger-light)',
                        color: presente ? '#4a6c0f' : 'var(--danger)'
                      }}>
                        {presente ? '✅ PRESENTE' : '❌ ASSENTE'}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {bp !== '—' ? (
                        <div style={{ 
                          fontWeight: 900, fontSize: '1rem',
                          color: bp <= 0 ? 'var(--danger)' : bp <= 2 ? 'var(--accent)' : 'var(--green)'
                        }}>
                          {bp}
                        </div>
                      ) : <span style={{ color: 'var(--border)' }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── TAB BUONI PASTO ─────────────────────────────────────────────────────────
function TabBuoniPasto({ iscrizioni, evento, user }) {
  const [buoni,     setBuoni]     = useState({})
  const [notifiche, setNotifiche] = useState([])
  const [logPag,    setLogPag]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [editPrezzo, setEditPrezzo] = useState(false)
  const [showLog,   setShowLog]   = useState(false)
  // Prezzo caricato sempre fresho dal DB (non dal prop evento che può essere stale)
  const [prezzoBuono, setPrezzoBuono] = useState(3.50)
  const [prezzoBuonoTemp, setPrezzoBuonoTemp] = useState(3.50)
  // Scalatura buoni
  const [modalScala, setModalScala] = useState(null) // { iscrizione }
  const [scalaQta,   setScalaQta]   = useState(1)
  const [scalaRimborso, setScalaRimborso] = useState(false)
  const [scalaMetodo,   setScalaMetodo]   = useState('Contanti')
  const [scalaNote,     setScalaNote]     = useState('')
  const [scalaSaving,   setScalaSaving]   = useState(false)
  // Modal aggiunta manuale buoni
  const [modalAdd, setModalAdd] = useState(null) // { iscrizione }
  const [addQta,   setAddQta]   = useState(5)
  const [addMetodo, setAddMetodo] = useState('Contanti')
  const [addNote,  setAddNote]  = useState('')
  const [addSaving, setAddSaving] = useState(false)

  const scalaManuale = async () => {
    setScalaSaving(true)
    const cur = buoni[modalScala.id] || 0
    const nuova = cur - scalaQta
    // Upsert su composite key (iscrizione_id, evento_id)
    await supabase.from('buoni_pasto').upsert({
      iscrizione_id: modalScala.id,
      evento_id:     evento.id,
      quantita:      nuova
    })

    if (scalaRimborso) {
      await supabase.from('log_pagamenti_buoni').insert([{
        evento_id:     evento.id,
        iscrizione_id: modalScala.id,
        nome_bambino:  `${modalScala.nome_bambino} ${modalScala.cognome_bambino}`,
        quantita:      -scalaQta,
        importo:       -(scalaQta * prezzoBuono),
        metodo:        scalaMetodo,
        note:          scalaNote || 'Rimborso',
        tipo:          'rimborso',
      }])
    }
    setBuoni(p => ({ ...p, [modalScala.id]: nuova }))
    logAudit({ user, azione: scalaRimborso ? 'RIMBORSO_BUONI' : 'SCALA_BUONI', categoria: 'Buoni Pasto',
      dettaglio: `${scalaRimborso ? 'Rimborsati' : 'Scalati'} ${scalaQta} buoni a ${modalScala.nome_bambino} ${modalScala.cognome_bambino}`,
      meta: { iscrizione_id: modalScala.id, evento_id: evento.id, quantita: scalaQta,
        rimborso: scalaRimborso, metodo: scalaMetodo,
        nome_bambino: modalScala.nome_bambino, cognome_bambino: modalScala.cognome_bambino } })
    const codiceScala = modalScala.codice_accesso || modalScala.codice_famiglia
    if (codiceScala) {
      sendPushNotification({
        titolo: `🎟️ Buoni pasto — ${modalScala.nome_bambino}`,
        corpo:  scalaRimborso
          ? `${scalaQta} buoni rimborsati dall'oratorio. Buoni rimanenti: ${nuova}`
          : `${scalaQta} buoni scalati dall'oratorio. Buoni rimanenti: ${nuova}`,
        target_tipo: 'genitore',
        target_ids: [codiceScala],
      })
    }
    setScalaSaving(false)
    setModalScala(null)
    setScalaQta(1); setScalaRimborso(false); setScalaNote('')
    carica()
  }

  const mensaIds     = (evento.servizi || []).filter(s => s.nome?.toLowerCase().includes('mensa')).map(s => s.id)
  // Bambini con diritto mensa = hanno almeno 1 settimana di mensa selezionata
  const bambiniMensa = iscrizioni.filter(i =>
    (i.mensa_settimane || []).length > 0 ||
    (i.servizi || []).some(sid => mensaIds.includes(sid)) // backward compat
  )
  const metodi       = evento.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']

  const carica = () => {
    setLoading(true)
    Promise.all([
      supabase.from('buoni_pasto').select('*').eq('evento_id', evento.id),
      supabase.from('notifiche_addebito').select('*').eq('evento_id', evento.id).eq('letta', false),
      supabase.from('log_pagamenti_buoni').select('*').eq('evento_id', evento.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('eventi').select('prezzo_buono').eq('id', evento.id).single(),
    ]).then(([{ data: bp }, { data: nt }, { data: lg }, { data: ev }]) => {
      const map = {}
      ;(bp || []).forEach(r => { map[r.iscrizione_id] = r.quantita })
      setBuoni(map)
      setNotifiche(nt || [])
      setLogPag(lg || [])
      // Carica prezzo sempre fresho dal DB
      const p = ev?.prezzo_buono || 3.50
      setPrezzoBuono(p)
      setPrezzoBuonoTemp(p)
      setLoading(false)
    })
  }
  useEffect(carica, [evento.id])

  // Auto-refresh ogni 30s come fallback al realtime
  useEffect(() => {
    const t = setInterval(carica, 30000)
    return () => clearInterval(t)
  }, [evento.id]) // eslint-disable-line

  // Realtime: aggiorna automaticamente quando arriva un acquisto pubblico
  useEffect(() => {
    const channel = supabase
      .channel(`buoni_pasto_${evento.id}`)
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table:  'buoni_pasto',
        filter: `evento_id=eq.${evento.id}`,
      }, (payload) => {
        // Aggiorna solo il record cambiato senza ricaricare tutto
        if (payload.new?.iscrizione_id) {
          setBuoni(p => ({ ...p, [payload.new.iscrizione_id]: payload.new.quantita }))
        }
      })
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'log_pagamenti_buoni',
        filter: `evento_id=eq.${evento.id}`,
      }, () => {
        // Ricarica il log acquisti quando arriva una nuova voce
        supabase.from('log_pagamenti_buoni').select('*')
          .eq('evento_id', evento.id)
          .order('created_at', { ascending: false })
          .limit(100)
          .then(({ data }) => { if (data) setLogPag(data) })
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [evento.id]) // eslint-disable-line

  const salvaPrezzo = async () => {
    await supabase.from('eventi').update({ prezzo_buono: +prezzoBuonoTemp }).eq('id', evento.id)
    setPrezzoBuono(+prezzoBuonoTemp); setEditPrezzo(false)
  }

  const aggiungiManuale = async () => {
    if (!addMetodo) { alert('Seleziona metodo di pagamento.'); return }
    setAddSaving(true)
    const cur = buoni[modalAdd.id] || 0
    const nuova = cur + addQta
    
    // update se esiste, insert altrimenti
    const { data: esAdd, error: fetchErr } = await supabase.from('buoni_pasto')
      .select('quantita')
      .eq('iscrizione_id', modalAdd.id)
      .eq('evento_id', evento.id)
      .maybeSingle()
    
    if (fetchErr) {
      alert('Errore recupero buoni: ' + fetchErr.message)
      setAddSaving(false)
      return
    }

    // Usiamo il valore fresco dal DB se disponibile
    const realCur = esAdd ? esAdd.quantita : 0
    const realNuova = realCur + addQta

    const { error: updErr } = await supabase.from('buoni_pasto').upsert({
      iscrizione_id: modalAdd.id,
      evento_id:     evento.id,
      quantita:      realNuova
    })

    if (updErr) {
      alert('Errore aggiornamento buoni: ' + updErr.message)
      setAddSaving(false)
      return
    }

    // Log pagamento
    await supabase.from('log_pagamenti_buoni').insert([{
      evento_id:     evento.id,
      iscrizione_id: modalAdd.id,
      nome_bambino:  `${modalAdd.nome_bambino} ${modalAdd.cognome_bambino}`,
      quantita:      addQta,
      importo:       addQta * prezzoBuono,
      metodo:        addMetodo,
      note:          addNote,
      tipo:          'acquisto_admin',
    }])

    // Aggiorna stato locale
    setBuoni(p => ({ ...p, [modalAdd.id]: realNuova }))
    
    logAudit({ user, azione: 'AGGIUNGE_BUONI', categoria: 'Buoni Pasto',
      dettaglio: `Aggiunti ${addQta} buoni a ${modalAdd.nome_bambino} ${modalAdd.cognome_bambino} — ${addMetodo} — ${fmt(addQta * prezzoBuono)}`,
      meta: { iscrizione_id: modalAdd.id, evento_id: evento.id, quantita: addQta,
        importo: addQta * prezzoBuono, metodo: addMetodo,
        nome_bambino: modalAdd.nome_bambino, cognome_bambino: modalAdd.cognome_bambino } })
    
    const codiceGenitore = modalAdd.codice_accesso || modalAdd.codice_famiglia
    if (codiceGenitore) {
      sendPushNotification({
        titolo: `🎟️ Buoni pasto — ${modalAdd.nome_bambino}`,
        corpo:  `${addQta} buoni aggiunti dall'oratorio. Totale: ${realNuova}`,
        target_tipo: 'genitore',
        target_ids: [codiceGenitore],
      })
    }
    setAddSaving(false); setModalAdd(null); setAddQta(5); setAddMetodo('Contanti'); setAddNote('')
    carica()
  }

  const segnaLetta = async (id) => {
    await supabase.from('notifiche_addebito').update({ letta: true }).eq('id', id)
    setNotifiche(p => p.filter(n => n.id !== id))
  }

  if (loading) return <LoadingPage text="Caricamento buoni..." />

  const totIncasso = logPag.filter(l => l.tipo !== 'rimborso').reduce((s, l) => s + (l.importo || 0), 0)

  return (
    <div>
      {/* Header con prezzo e stats */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-ghost" onClick={carica} style={{ marginLeft: 'auto' }}>
          🔄 Aggiorna
        </button>
        <div style={{ background: 'var(--primary-pale)', border: '2px solid var(--primary)', borderRadius: 12, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '.85rem', color: 'var(--text-muted)', fontWeight: 700 }}>💰 Prezzo per buono</span>
          {editPrezzo
            ? <>
                <input type="number" step="0.01" className="form-input" style={{ width: 90, padding: '4px 8px' }}
                  value={prezzoBuonoTemp} onChange={e => setPrezzoBuonoTemp(e.target.value)} />
                <button className="btn btn-sm btn-success" onClick={salvaPrezzo}>✓</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditPrezzo(false)}>✕</button>
              </>
            : <>
                <span style={{ fontWeight: 900, fontSize: '1.2rem', color: 'var(--primary)' }}>{fmt(prezzoBuono)}</span>
                <button className="btn btn-sm btn-ghost" style={{ padding: '4px 10px' }} onClick={() => { setPrezzoBuonoTemp(prezzoBuono); setEditPrezzo(true) }}>✏️</button>
              </>
          }
        </div>
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '10px 18px', textAlign: 'center' }}>
          <div style={{ fontWeight: 900, color: '#166534' }}>{fmt(totIncasso)}</div>
          <div style={{ fontSize: '.75rem', color: '#166534' }}>incassato</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowLog(!showLog)}>
          📋 {showLog ? 'Nascondi' : 'Mostra'} log pagamenti ({logPag.length})
        </button>
      </div>

      {/* Log pagamenti */}
      {showLog && (
        <div className="card" style={{ padding: 0, marginBottom: 20 }}>
          <div style={{ padding: '12px 20px', fontWeight: 800, borderBottom: '1px solid var(--border)', color: 'var(--primary)' }}>
            📋 Log pagamenti buoni
          </div>
          {logPag.length === 0
            ? <div className="alert alert-info" style={{ margin: 12 }}>Nessun pagamento registrato.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Data/Ora</th><th>Bambino</th><th style={{textAlign:'center'}}>Q.tà</th><th style={{textAlign:'right'}}>Importo</th><th>Metodo</th><th>Tipo</th><th>Note</th></tr></thead>
                <tbody>{logPag.map(l => (
                  <tr key={l.id}>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString('it')}</td>
                    <td><b>{l.nome_bambino}</b></td>
                    <td style={{ textAlign: 'center' }}>+{l.quantita}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--success)' }}>{fmt(l.importo)}</td>
                    <td><span style={{ fontSize: '.8rem' }}>{l.metodo === 'Contanti' ? '💵' : l.metodo === 'POS/Carta' ? '💳' : '🏦'} {l.metodo}</span></td>
                    <td><span style={{ fontSize: '.75rem', background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: 999 }}>{l.tipo === 'acquisto_admin' ? 'Admin' : l.tipo === 'acquisto_pub' ? 'Online' : l.tipo}</span></td>
                    <td><small style={{ color: 'var(--text-muted)' }}>{l.note}</small></td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}

      {/* Notifiche addebito */}
      {notifiche.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 800, color: 'var(--danger)', marginBottom: 10 }}>⚠️ Addebiti sospesi ({notifiche.length})</div>
          {notifiche.map(n => (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff5f5', border: '1px solid #fed7d7', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
              <div>
                <b>{n.nome_bambino}</b> — mensa senza buoni il <b>{n.data}</b>
                {n.email && <div style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>📧 {n.email}</div>}
              </div>
              <button className="btn btn-sm btn-success" onClick={() => segnaLetta(n.id)}>✅ Saldato</button>
            </div>
          ))}
        </div>
      )}

      {mensaIds.length === 0 && <div className="alert alert-warn">Nessun servizio mensa configurato. Aggiungi un servizio "Mensa" tra i servizi evento.</div>}
      {bambiniMensa.length === 0 && mensaIds.length > 0 && <div className="alert alert-info">Nessun bambino iscritto alla mensa.</div>}

      {bambiniMensa.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 20px', fontWeight: 700, borderBottom: '1px solid var(--border)' }}>
            🎟️ Buoni pasto — {bambiniMensa.length} bambini
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th>Bambino</th><th>Email</th><th style={{textAlign:'center'}}>Buoni</th><th style={{textAlign:'center'}}>Valore</th><th style={{textAlign:'center'}}>Azioni</th></tr></thead>
            <tbody>{bambiniMensa.map(i => {
              const q = buoni[i.id] || 0
              return (
                <tr key={i.id}>
                  <td><b>{i.nome_bambino} {i.cognome_bambino}</b></td>
                  <td><small>{i.email_genitore}</small></td>
                  <td style={{ textAlign: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: '1.15rem', color: q === 0 ? 'var(--danger)' : q <= 2 ? 'var(--accent)' : 'var(--success)' }}>
                      {q === 0 ? '⚠️ 0' : q}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center', fontSize: '.85rem', color: 'var(--text-muted)' }}>
                    {q > 0 ? fmt(q * prezzoBuono) : '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                      <button className="btn btn-sm btn-primary" onClick={() => { setModalAdd(i); setAddQta(5); setAddMetodo(metodi[0] || 'Contanti'); setAddNote('') }}>
                        + Aggiungi
                      </button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                        onClick={() => { setModalScala(i); setScalaQta(1); setScalaRimborso(false); setScalaMetodo(metodi[0] || 'Contanti'); setScalaNote('') }}>
                        − Scala
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        </div>
      )}

      {/* Modal aggiunta manuale buoni */}
      {modalAdd && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModalAdd(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-title">🎟️ Aggiungi buoni — {modalAdd.nome_bambino} {modalAdd.cognome_bambino}</div>
            <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: '.85rem' }}>
              Buoni attuali: <b>{buoni[modalAdd.id] || 0}</b> · Prezzo unitario: <b>{fmt(prezzoBuono)}</b>
            </div>
            <div className="form-group">
              <label className="form-label">Quantità buoni da aggiungere</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[1,5,10,20].map(q => (
                  <button key={q} type="button" className={`btn ${addQta === q ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAddQta(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ background: 'var(--primary-pale)', borderRadius: 10, padding: '10px 16px', marginBottom: 16 }}>
              <b>Importo: {fmt(addQta * prezzoBuono)}</b> ({addQta} × {fmt(prezzoBuono)})
            </div>
            <div className="form-group">
              <label className="form-label">Metodo di pagamento *</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {metodi.map(m => (
                  <button key={m} type="button" className={`btn ${addMetodo === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAddMetodo(m)}>
                    {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Note (opzionale)</label>
              <input className="form-input" value={addNote} onChange={e => setAddNote(e.target.value)} placeholder="es. Pagato in segreteria il..." />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setModalAdd(null)}>Annulla</button>
              <button className="btn btn-success" onClick={aggiungiManuale} disabled={addSaving}>
                {addSaving ? <><span className="spinner" /> Salvataggio...</> : `✅ Aggiungi ${addQta} buoni — ${fmt(addQta * prezzoBuono)}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal scalatura buoni */}
      {modalScala && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModalScala(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-title">➖ Scala buoni — {modalScala.nome_bambino} {modalScala.cognome_bambino}</div>
            <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: '.85rem' }}>
              Buoni attuali: <b>{buoni[modalScala.id] || 0}</b>
            </div>
            <div className="form-group">
              <label className="form-label">Quantità da scalare</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[1,2,3,5,10].map(q => (
                  <button key={q} type="button"
                    className={`btn ${scalaQta === q ? 'btn-danger' : 'btn-ghost'}`}
                    onClick={() => setScalaQta(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ background: '#fff3f3', border: '1.5px solid var(--danger)', borderRadius: 10, padding: '10px 16px', marginBottom: 16 }}>
              Dopo la scalatura: <b>{(buoni[modalScala.id] || 0) - scalaQta} buoni</b>
            </div>
            {/* Rimborso — opzionale */}
            <div className="form-group">
              <label className={`check-item ${scalaRimborso ? 'checked' : ''}`} style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={scalaRimborso} onChange={e => setScalaRimborso(e.target.checked)} />
                <span>💰 Registra anche un rimborso ({fmt(scalaQta * prezzoBuono)})</span>
              </label>
            </div>
            {scalaRimborso && (
              <>
                <div className="form-group">
                  <label className="form-label">Metodo rimborso</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {metodi.map(m => (
                      <button key={m} type="button" className={`btn ${scalaMetodo === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setScalaMetodo(m)}>
                        {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Note rimborso (opzionale)</label>
                  <input className="form-input" value={scalaNote} onChange={e => setScalaNote(e.target.value)} placeholder="es. Rimborso per errore acquisto" />
                </div>
              </>
            )}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setModalScala(null)}>Annulla</button>
              <button className="btn btn-danger" onClick={scalaManuale} disabled={scalaSaving}>
                {scalaSaving ? <><span className="spinner" /> Salvataggio...</> : `➖ Scala ${scalaQta} buoni${scalaRimborso ? ` + rimborso ${fmt(scalaQta * prezzoBuono)}` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TAB COMUNICAZIONI ───────────────────────────────────────────────────────
function TabComunicazioni({ iscrizioni, evento, user }) {
  const [dest,         setDest]         = useState('tutti')
  const [selIds,       setSelIds]       = useState([])
  const [singolo,      setSingolo]      = useState('')
  const [catCampo,     setCatCampo]     = useState('')   // campo extra per filtro categoria
  const [catValore,    setCatValore]    = useState('')   // valore scelto
  const [oggetto,  setOggetto]  = useState('')
  const [testo,    setTesto]    = useState('')
  const [immagine, setImmagine] = useState(null)
  const [imgName,  setImgName]  = useState('')
  const [storico,  setStorico]  = useState([])
  const [loadStor, setLoadStor] = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [sent,     setSent]     = useState(false)
  const [deleting,   setDeleting]   = useState(null)
  const [savingPush, setSavingPush] = useState(false)
  const [pushSent,   setPushSent]   = useState(false)

  useEffect(() => {
    supabase.from('comunicazioni_inviate')
      .select('*').eq('evento_id', evento.id)
      .order('inviata_il', { ascending: false }).limit(30)
      .then(({ data }) => { setStorico(data || []); setLoadStor(false) })
  }, [evento.id, sent])

  const toggleSel = (id) => setSelIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])

  const calcEtaCom = (dataNascita) => {
    if (!dataNascita) return null
    const oggi = new Date(); const n = new Date(dataNascita)
    let eta = oggi.getFullYear() - n.getFullYear()
    if (oggi.getMonth() < n.getMonth() || (oggi.getMonth() === n.getMonth() && oggi.getDate() < n.getDate())) eta--
    return eta
  }
  const campiExtraCom = (evento.campi_extra || []).filter(c => c.tipo === 'select' || c.tipo === 'radio')
  // Categorie disponibili nelle comunicazioni (stesso set di TabIscritti)
  const categorieCom = [
    { id: '__eta__', label: 'Fascia d età', opzioni: () => {
      const fasce = {'< 6 anni':0,'6-8 anni':0,'9-11 anni':0,'12-14 anni':0,'15+ anni':0,'Non specificata':0}
      iscrizioni.forEach(i => {
        const eta = calcEtaCom(i.data_nascita)
        if (eta===null) fasce['Non specificata']++
        else if (eta<6) fasce['< 6 anni']++
        else if (eta<=8) fasce['6-8 anni']++
        else if (eta<=11) fasce['9-11 anni']++
        else if (eta<=14) fasce['12-14 anni']++
        else fasce['15+ anni']++
      })
      return Object.entries(fasce).filter(([,n])=>n>0).map(([v,n])=>({v,n}))
    }},
    { id: '__settimane__', label: 'Settimana iscritta', opzioni: () => {
      const c = {}; iscrizioni.forEach(i => (i.settimane||[]).forEach(s => { const k=`Settimana ${s}`; c[k]=(c[k]||0)+1 }))
      return Object.entries(c).sort((a,b)=>a[0].localeCompare(b[0])).map(([v,n])=>({v,n}))
    }},
    { id: '__mensa__', label: 'Mensa', opzioni: () => {
      const c = {}; iscrizioni.forEach(i => (i.mensa_settimane||[]).forEach(s => { const k=`Mensa sett. ${s}`; c[k]=(c[k]||0)+1 }))
      const nessuna = iscrizioni.filter(i=>!(i.mensa_settimane||[]).length).length
      if (nessuna>0) c['Senza mensa']=nessuna
      return Object.entries(c).filter(([,n])=>n>0).map(([v,n])=>({v,n}))
    }},
    { id: '__comune__', label: 'Comune', opzioni: () => {
      const c = {}; iscrizioni.forEach(i => { if(i.comune_residenza) c[i.comune_residenza]=(c[i.comune_residenza]||0)+1 })
      return Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([v,n])=>({v,n}))
    }},
    ...campiExtraCom.map(campo => ({
      id: campo.id, label: campo.label,
      opzioni: () => {
        const c = {}
        iscrizioni.forEach(i => { const v=(i.dati_extra||{})[campo.id]; if(v) c[v]=(c[v]||0)+1 })
        return Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([v,n])=>({v,n}))
      }
    }))
  ].filter(cat => cat.opzioni().length > 0)

  const opzCatCom = catCampo
    ? (categorieCom.find(c => c.id === catCampo)?.opzioni() || [])
    : []

  const destinatari = (() => {
    if (dest === 'tutti')      return iscrizioni.filter(i => i.email_genitore)
    if (dest === 'selezione')  return iscrizioni.filter(i => selIds.includes(i.id) && i.email_genitore)
    if (dest === 'singolo')    return iscrizioni.filter(i => i.id === singolo && i.email_genitore)
    if (dest === 'categoria') return iscrizioni.filter(i => {
      if (!i.email_genitore) return false
      if (!catCampo || !catValore) return false
      const cat = categorieCom.find(c => c.id === catCampo)
      if (!cat) return false
      // built-in checks
      if (catCampo === '__eta__') {
        const eta = calcEtaCom(i.data_nascita)
        if (catValore === '< 6 anni') return eta !== null && eta < 6
        if (catValore === '6-8 anni') return eta !== null && eta >= 6 && eta <= 8
        if (catValore === '9-11 anni') return eta !== null && eta >= 9 && eta <= 11
        if (catValore === '12-14 anni') return eta !== null && eta >= 12 && eta <= 14
        if (catValore === '15+ anni') return eta !== null && eta >= 15
        if (catValore === 'Non specificata') return !i.data_nascita
        return false
      }
      if (catCampo === '__settimane__') return (i.settimane||[]).includes(parseInt(catValore.replace('Settimana ','')))
      if (catCampo === '__mensa__') {
        if (catValore === 'Senza mensa') return !(i.mensa_settimane||[]).length
        return (i.mensa_settimane||[]).includes(parseInt(catValore.replace('Mensa sett. ','')))
      }
      if (catCampo === '__comune__') return i.comune_residenza === catValore
      return (i.dati_extra||{})[catCampo] === catValore
    })
    return []
  })()

  const handleImg = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImgName(file.name)
    const r = new FileReader()
    r.onload = () => setImmagine(r.result)
    r.readAsDataURL(file)
  }

    const invia = async () => {
    if (!oggetto.trim() || !testo.trim()) { alert('Compila oggetto e testo.'); return }
    setSaving(true)
    const payload = JSON.stringify({ testo, immagine: immagine || null })
    const { error } = await supabase.from('comunicazioni_inviate').insert([{
      evento_id:         evento.id,
      oggetto,
      messaggio:         payload,
      destinatari_count: destinatari.length,
    }])
    setSaving(false)
    if (error) { alert('Errore nel salvataggio. Riprova.'); return }
    logAudit({ user, azione: 'INVIA_COMUNICAZIONE', categoria: 'Comunicazioni',
      dettaglio: `Comunicazione "${oggetto}" inviata a ${destinatari.length} destinatari (${evento.nome})`,
      meta: { evento_id: evento.id, evento_nome: evento.nome,
        oggetto, destinatari_count: destinatari.length } })
    // Notifica push ai genitori destinatari
    const codiciDestinatari = destinatari
      .map(i => i.codice_accesso || i.codice_famiglia)
      .filter(Boolean)
    sendPushNotification({
      titolo:  `📣 ${evento.nome}`,
      corpo:   oggetto,
      target_tipo: 'genitore',
      target_ids: codiciDestinatari.length > 0 ? codiciDestinatari : null,
    })
    setSent(true)
    setOggetto(''); setTesto(''); setImmagine(null); setImgName(''); setSelIds([])
    setTimeout(() => setSent(false), 4000)
  }

  const eliminaComunicazione = async (id) => {
    if (!window.confirm('Eliminare questa comunicazione? Sparirà anche dall\'area genitori.')) return
    setDeleting(id)
    const comm = storico.find(c => c.id === id)
    await supabase.from('comunicazioni_inviate').delete().eq('id', id)
    logAudit({ user, azione: 'ELIMINA_COMUNICAZIONE', categoria: 'Comunicazioni',
      dettaglio: `Eliminata comunicazione "${comm?.oggetto || ''}" (${evento.nome})`,
      meta: { comunicazione_id: id, evento_id: evento.id, oggetto: comm?.oggetto } })
    setStorico(p => p.filter(c => c.id !== id))
    setDeleting(null)
  }

  const inviaPush = async () => {
    if (!oggetto.trim() || !testo.trim()) { alert('Compila oggetto e testo.'); return }
    setSavingPush(true)
    const codiciPush = destinatari
      .map(i => i.codice_accesso || i.codice_famiglia)
      .filter(Boolean)
    await sendPushNotification({
      titolo:  `📣 ${evento.nome}: ${oggetto}`,
      corpo:   testo.substring(0, 200),
      target_tipo: 'genitore',
      target_ids: codiciPush.length > 0 ? codiciPush : null,
    })
    setSavingPush(false)
    setPushSent(true)
    setTimeout(() => setPushSent(false), 4000)
  }

  const nomiDest = (() => {
    if (dest === 'tutti') return `Tutti (${iscrizioni.filter(i=>i.email_genitore).length} famiglie)`
    if (dest === 'selezione') return `${selIds.length} selezionati`
    if (dest === 'singolo' && singolo) {
      const i = iscrizioni.find(x => x.id === singolo)
      return i ? `${i.nome_bambino} ${i.cognome_bambino}` : '—'
    }
    if (dest === 'categoria' && catCampo && catValore) {
      const campoCom = categorieCom.find(c => c.id === catCampo)
      return `${campoCom?.label || catCampo}: ${catValore} (${destinatari.length} famiglie)`
    }
    return '—'
  })()

  return (
    <div>
      {sent && <div className="alert alert-success" style={{ marginBottom: 16 }}>✅ Comunicazione salvata! Sarà visibile nell'area genitori.</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 16, color: 'var(--primary)' }}>📣 Nuova comunicazione</div>

        {/* Destinatari */}
        <div className="form-group">
          <label className="form-label">Destinatari *</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {[['tutti','👨‍👩‍👧 Tutti'],['selezione','☑️ Selezione'],['singolo','👤 Singolo'],
              ...(categorieCom.length > 0 ? [['categoria','🔖 Per categoria']] : [])
            ].map(([v,l]) => (
              <button key={v} type="button"
                className={`btn ${dest === v ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setDest(v); setSelIds([]); setSingolo(''); setCatCampo(''); setCatValore('') }}>
                {l}
              </button>
            ))}
          </div>

          {dest === 'categoria' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', background: 'var(--bg)', borderRadius: 10, marginBottom: 10 }}>
              <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-muted)' }}>🔖 Filtra per:</span>
              <select className="form-select" style={{ width: 'auto', padding: '5px 12px', fontSize: '.84rem' }}
                value={catCampo} onChange={e => { setCatCampo(e.target.value); setCatValore('') }}>
                <option value="">— Scegli campo —</option>
                {categorieCom.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              {catCampo && (
                <select className="form-select" style={{ width: 'auto', padding: '5px 12px', fontSize: '.84rem' }}
                  value={catValore} onChange={e => setCatValore(e.target.value)}>
                  <option value="">— Scegli valore —</option>
                  {opzCatCom.map(({v,n}) => (
                    <option key={v} value={v}>{v} ({n} iscritti)</option>
                  ))}
                </select>
              )}
              {catCampo && catValore && (
                <span style={{ background: 'var(--primary-pale)', color: 'var(--primary)', borderRadius: 20, padding: '4px 12px', fontWeight: 700, fontSize: '.8rem' }}>
                  ✅ {destinatari.length} destinatari selezionati
                </span>
              )}
            </div>
          )}

          {dest === 'selezione' && (
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1.5px solid var(--border)', borderRadius: 10, padding: 12 }}>
              {iscrizioni.map(i => (
                <label key={i.id} className={`check-item ${selIds.includes(i.id) ? 'checked' : ''}`} style={{ marginBottom: 6 }}>
                  <input type="checkbox" checked={selIds.includes(i.id)} onChange={() => toggleSel(i.id)} />
                  <span>
                    <b>{i.nome_bambino} {i.cognome_bambino}</b>
                    {i.email_genitore
                      ? <span style={{ color: 'var(--text-muted)', fontSize: '.8rem', marginLeft: 6 }}>{i.email_genitore}</span>
                      : <span style={{ color: 'var(--danger)', fontSize: '.8rem', marginLeft: 6 }}>⚠️ no email</span>
                    }
                  </span>
                </label>
              ))}
            </div>
          )}

          {dest === 'singolo' && (
            <select className="form-select" value={singolo} onChange={e => setSingolo(e.target.value)}>
              <option value="">— Seleziona bambino —</option>
              {iscrizioni.map(i => (
                <option key={i.id} value={i.id}>
                  {i.nome_bambino} {i.cognome_bambino}{i.email_genitore ? '' : ' ⚠️ no email'}
                </option>
              ))}
            </select>
          )}

          <div style={{ marginTop: 8, fontSize: '.83rem', color: 'var(--text-muted)' }}>
            📬 Destinatari: <b>{nomiDest}</b>
          </div>
        </div>

        {/* Oggetto */}
        <div className="form-group">
          <label className="form-label">Oggetto *</label>
          <input className="form-input" value={oggetto} onChange={e => setOggetto(e.target.value)}
            placeholder={`Aggiornamento ${evento.nome}`} />
        </div>

        {/* Testo */}
        <div className="form-group">
          <label className="form-label">Testo comunicazione *</label>
          <textarea className="form-textarea" style={{ minHeight: 160 }} value={testo}
            onChange={e => setTesto(e.target.value)}
            placeholder={"Gentili genitori,[il vostro messaggio]Grazie"} />
        </div>

        {/* Immagine allegata */}
        <div className="form-group">
          <label className="form-label">Immagine allegata (opzionale)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
              📎 Scegli immagine
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImg} />
            </label>
            {imgName && (
              <>
                <span style={{ fontSize: '.83rem', color: 'var(--text-muted)' }}>{imgName}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => { setImmagine(null); setImgName('') }}>✕</button>
              </>
            )}
          </div>
          {immagine && (
            <img src={immagine} alt="anteprima"
              style={{ marginTop: 10, maxWidth: '100%', maxHeight: 200, borderRadius: 10, objectFit: 'contain', border: '1.5px solid var(--border)' }} />
          )}
          <div className="form-hint">L'immagine viene mostrata come anteprima. Verrà allegata manualmente alla mail prima dell'invio.</div>
        </div>

        <div className="alert alert-info" style={{ fontSize: '.82rem', marginBottom: 14 }}>
          📧 Cliccando Invia si aprirà il client email con i destinatari in BCC e il testo già compilato. Se hai un'immagine, allegala manualmente dalla finestra email.
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-primary btn-lg" onClick={invia} disabled={saving || !oggetto || !testo}>
            {saving ? <><span className="spinner" /> Salvataggio...</> : `📣 Pubblica comunicazione`}
          </button>
          <button
            className="btn btn-lg"
            style={{ background: '#4f46e5', color: '#fff' }}
            onClick={inviaPush}
            disabled={savingPush || !oggetto || !testo}
            title="Invia notifica push immediata ai destinatari selezionati">
            {savingPush ? <><span className="spinner" /> Invio push...</> : `🔔 Invia push`}
          </button>
        </div>
        {pushSent && <div className="alert alert-success" style={{ marginTop: 12 }}>🔔 Notifica push inviata!</div>}
      </div>

      {/* Storico comunicazioni */}
      <div className="card">
        <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 14, color: 'var(--primary)' }}>📋 Storico comunicazioni inviate</div>
        {loadStor
          ? <LoadingPage text="Caricamento storico..." />
          : storico.length === 0
            ? <div className="alert alert-info">Nessuna comunicazione ancora inviata.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Data</th><th>Oggetto</th><th style={{textAlign:'center'}}>Dest.</th><th>Anteprima</th><th></th></tr></thead>
                <tbody>{storico.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>{new Date(c.inviata_il).toLocaleString('it')}</td>
                    <td><b>{c.oggetto}</b></td>
                    <td style={{ textAlign: 'center' }}>{c.destinatari_count}</td>
                    <td><small style={{ color: 'var(--text-muted)' }}>{(() => { try { return JSON.parse(c.messaggio||'{}').testo || c.messaggio } catch(e) { return c.messaggio } })().substring(0,80)}…</small></td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => eliminaComunicazione(c.id)}
                        disabled={deleting === c.id}
                        title="Elimina comunicazione">
                        {deleting === c.id ? '⏳' : '🗑️'}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
        }
      </div>
    </div>
  )
}

// ─── TAB MAIL ────────────────────────────────────────────────────────────────
function TabMail({ iscrizioni, evento }) {
  const [oggetto, setOggetto] = useState('')
  const [messaggio, setMessaggio] = useState('')
  const [inviato, setInviato] = useState(false)

  const destinatari = iscrizioni.filter(i => i.email_genitore).map(i => i.email_genitore)
  const destinatariUnique = [...new Set(destinatari)]

  const invia = async () => {
    if (!oggetto || !messaggio) { alert('Compila oggetto e messaggio.'); return }
    if (destinatariUnique.length === 0) { alert('Nessun indirizzo email disponibile tra gli iscritti.'); return }

    // Log comunicazione
    await supabase.from('comunicazioni_inviate').insert([{
      evento_id: evento.id, oggetto, messaggio,
      destinatari_count: destinatariUnique.length,
    }]).catch(() => {}) // ignora se tabella non esiste ancora

    // Apri client mail con tutti in BCC
    const bcc = destinatariUnique.join(',')
    const corpo = encodeURIComponent(messaggio + '---Oratorio di Sergnano — Comunicazione automatica gestionale')
    const sogg = encodeURIComponent(`[${evento.nome}] ${oggetto}`)
    window.open(`mailto:?bcc=${bcc}&subject=${sogg}&body=${corpo}`)
    setInviato(true)
  }

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        📧 La mail verrà aperta nel tuo client email con tutti i destinatari in <b>BCC</b> (nascosti tra loro). Sono disponibili <b>{destinatariUnique.length}</b> indirizzi su {iscrizioni.length} iscritti.
      </div>
      {inviato && <div className="alert alert-success" style={{ marginBottom: 16 }}>✅ Client email aperto con {destinatariUnique.length} destinatari in BCC!</div>}
      <div className="form-group">
        <label className="form-label">Oggetto *</label>
        <input className="form-input" value={oggetto} onChange={e => setOggetto(e.target.value)} placeholder={`Aggiornamento ${evento.nome}`} />
      </div>
      <div className="form-group">
        <label className="form-label">Messaggio *</label>
        <textarea className="form-textarea" style={{ minHeight: 160 }} value={messaggio} onChange={e => setMessaggio(e.target.value)}
          placeholder="Gentili genitori,&#10;&#10;[il vostro messaggio]&#10;&#10;Grazie" />
      </div>
      <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: '.85rem' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>📋 Destinatari ({destinatariUnique.length})</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {destinatariUnique.map(e => <span key={e} style={{ background: 'var(--primary-pale)', color: 'var(--primary)', padding: '2px 8px', borderRadius: 999, fontSize: '.78rem' }}>{e}</span>)}
        </div>
        {destinatariUnique.length < iscrizioni.length && (
          <div style={{ marginTop: 8, color: 'var(--text-muted)' }}>
            ℹ️ {iscrizioni.length - destinatariUnique.length} iscritti senza email registrata.
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-lg" onClick={invia} disabled={!oggetto || !messaggio || destinatariUnique.length === 0}>
        📧 Apri client email e invia
      </button>
    </div>
  )
}

// ─── MODAL CREA EVENTO ────────────────────────────────────────────────────────
function ModalCreaEvento({ onClose, user }) {
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    nome: '', descrizione: '', data_inizio: '', data_fine: '',
    quota_base: 50, prezzo_settimana: 80, prezzo_giornata: 20, sconto_fratelli: 10,
    servizi: [
      { id: uid(), nome: 'Mensa', prezzo: 30 },
      { id: uid(), nome: 'Pre-orario', prezzo: 15 },
      { id: uid(), nome: 'Doposcuola', prezzo: 20 },
    ],
    campi_extra: [], // campi aggiuntivi del form di iscrizione
    metodi_pagamento: ['Contanti', 'POS/Carta', 'Bonifico'], // metodi accettati
    campi_base: { // campi base opzionali
      nome_bambino: true, cognome_bambino: true, data_nascita: false, comune_residenza: false,
      nome_genitore: true, cognome_genitore: true, email_genitore: true, telefono_genitore: true,
      settimane: true, servizi: true, mensa: true, is_fratello: false, note: false,
      consenso_privacy: true, consenso_foto: false, consenso_regolamento: false,
    }
  })
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const steps = ['Informazioni', 'Date & Prezzi', 'Servizi', '💳 Pagamento', '⚙️ Campi Base', '➕ Campi Extra', 'Conferma']
  const TUTTI_METODI = ['Contanti', 'POS/Carta', 'Bonifico']

  const crea = async () => {
    if (!form.nome || !form.data_inizio || !form.data_fine) { alert('Compila tutti i campi obbligatori.'); return }
    setSaving(true)
    try {
      const { error } = await supabase.from('eventi').insert([{ ...form, attivo: true }])
      if (error) {
        alert('Errore nella creazione evento: ' + error.message)
        setSaving(false)
        return
      }
      logAudit({ user, azione: 'CREA_EVENTO', categoria: 'Eventi',
        dettaglio: `Creato evento "${form.nome}"`,
        meta: { nome: form.nome, data_inizio: form.data_inizio, data_fine: form.data_fine } })
      setSaving(false)
      onClose()
    } catch (err) {
      alert('Errore nella creazione evento: ' + err.message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">🎪 Crea nuovo evento</div>
        <div className="steps">
          {steps.map((s, i) => (
            <div key={i} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
              <div className="step-num">{i < step ? '✓' : i + 1}</div>
              <div className="step-label" style={{ fontSize: '.68rem' }}>{s}</div>
            </div>
          ))}
        </div>
        {step === 0 && <>
          <div className="form-group"><label className="form-label">Nome evento *</label><input className="form-input" value={form.nome} onChange={e => set('nome', e.target.value)} placeholder="es. Grest 2026" /></div>
          <div className="form-group"><label className="form-label">Descrizione</label><textarea className="form-textarea" value={form.descrizione} onChange={e => set('descrizione', e.target.value)} /></div>
        </>}
        {step === 1 && <>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Data inizio *</label><input className="form-input" type="date" value={form.data_inizio} onChange={e => set('data_inizio', e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Data fine *</label><input className="form-input" type="date" value={form.data_fine} onChange={e => set('data_fine', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Quota base (€)</label><input className="form-input" type="number" value={form.quota_base} onChange={e => set('quota_base', +e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Prezzo settimana (€)</label><input className="form-input" type="number" value={form.prezzo_settimana} onChange={e => set('prezzo_settimana', +e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Prezzo giornata (€)</label><input className="form-input" type="number" value={form.prezzo_giornata} onChange={e => set('prezzo_giornata', +e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Sconto fratelli (€)</label><input className="form-input" type="number" value={form.sconto_fratelli} onChange={e => set('sconto_fratelli', +e.target.value)} /></div>
          </div>
        </>}
        {step === 2 && <>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: '.9rem' }}>Servizi aggiuntivi disponibili per questo evento:</p>
          {form.servizi.map((s, i) => (
            <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input className="form-input" value={s.nome} placeholder="Nome servizio" onChange={e => set('servizi', form.servizi.map((x, j) => j === i ? { ...x, nome: e.target.value } : x))} />
              <input className="form-input" type="number" value={s.prezzo} style={{ width: 100 }} onChange={e => set('servizi', form.servizi.map((x, j) => j === i ? { ...x, prezzo: +e.target.value } : x))} />
              <button className="btn btn-sm btn-danger" onClick={() => set('servizi', form.servizi.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => set('servizi', [...form.servizi, { id: uid(), nome: '', prezzo: 0 }])}>+ Aggiungi servizio</button>
        </>}
        {step === 3 && <>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: '.9rem' }}>Seleziona i metodi di pagamento accettati per questo evento:</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            {TUTTI_METODI.map(m => (
              <button key={m} type="button"
                className={`btn ${form.metodi_pagamento.includes(m) ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => set('metodi_pagamento', form.metodi_pagamento.includes(m) ? form.metodi_pagamento.filter(x => x !== m) : [...form.metodi_pagamento, m])}>
                {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
              </button>
            ))}
          </div>
          <div className="alert alert-info">Nel form di iscrizione, il genitore vedrà solo i metodi selezionati.</div>
          <div style={{ marginTop: 20, fontWeight: 700, marginBottom: 8 }}>🍽️ Servizio Mensa</div>
          <div className="alert alert-info" style={{ fontSize: '.85rem' }}>
            <b>Come funziona il servizio Mensa:</b><br/>
            • Aggiungi un servizio con "Mensa" nel nome tra i servizi qui sopra<br/>
            • Il prezzo del servizio non viene usato — la mensa viene addebitata <b>€5 per settimana</b><br/>
            • In fase di iscrizione, il genitore selezionerà le settimane in cui il bambino mangia in mensa<br/>
            • Durante l'appello, il pulsante "Mensa" sarà disattivato per i bambini non iscritti quella settimana<br/>
            • I bambini con almeno una settimana di mensa possono acquistare buoni pasto
          </div>
        </>}
        {step === 4 && <>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            Seleziona quali campi base mostrare nel modulo di iscrizione pubblico. I campi selezionati saranno obbligatori.
          </div>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>👦 Dati bambino</div>
            <div className="check-group">
              {[
                { key: 'nome_bambino', label: 'Nome bambino' },
                { key: 'cognome_bambino', label: 'Cognome bambino' },
                { key: 'data_nascita', label: 'Data di nascita' },
                { key: 'comune_residenza', label: 'Comune di residenza' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>👨‍👩‍👧 Dati genitore</div>
            <div className="check-group">
              {[
                { key: 'nome_genitore', label: 'Nome genitore' },
                { key: 'cognome_genitore', label: 'Cognome genitore' },
                { key: 'email_genitore', label: 'Email genitore' },
                { key: 'telefono_genitore', label: 'Telefono genitore' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>📅 Iscrizione</div>
            <div className="check-group">
              {[
                { key: 'settimane', label: 'Settimane di partecipazione' },
                { key: 'servizi', label: 'Servizi aggiuntivi' },
                { key: 'mensa', label: 'Servizio mensa (se presente)' },
                { key: 'is_fratello', label: 'Sconto fratello/sorella' },
                { key: 'note', label: 'Note aggiuntive' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>✅ Consensi</div>
            <div className="check-group">
              {[
                { key: 'consenso_privacy', label: 'Consenso privacy (GDPR)' },
                { key: 'consenso_foto', label: 'Consenso pubblicazione foto' },
                { key: 'consenso_regolamento', label: 'Accettazione regolamento' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>}
        {step === 5 && <>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            Aggiungi campi extra al modulo di iscrizione pubblico: codice fiscale, classe, allergie, ecc. I dati vengono salvati e visibili nell'elenco iscritti.
          </div>
          <EditorCampiExtra campi={form.campi_extra} onChange={v => set('campi_extra', v)} />
        </>}
        {step === 6 && <>
          <div className="price-box">
            <div style={{ fontWeight: 800, marginBottom: 12, color: 'var(--primary)' }}>✅ Riepilogo evento</div>
            <div style={{ display: 'grid', gap: 8, fontSize: '.9rem' }}>
              <div><b>Nome:</b> {form.nome}</div>
              <div><b>Periodo:</b> {form.data_inizio} → {form.data_fine}</div>
              <div><b>Quota base:</b> {fmt(form.quota_base)} | <b>Settimana:</b> {fmt(form.prezzo_settimana)} | <b>Giornata:</b> {fmt(form.prezzo_giornata)}</div>
              <div><b>Sconto fratelli:</b> -{fmt(form.sconto_fratelli)}</div>
              <div><b>Servizi:</b> {form.servizi.length === 0 ? 'Nessuno' : form.servizi.map(s => `${s.nome} (${fmt(s.prezzo)})`).join(', ')}</div>
              <div><b>Campi base abilitati:</b> {Object.keys(form.campi_base).filter(k => form.campi_base[k]).length}</div>
              <div><b>Campi extra:</b> {form.campi_extra.length === 0 ? 'Nessuno' : form.campi_extra.map(c => c.label || '(senza nome)').join(', ')}</div>
              <div><b>Metodi pagamento:</b> {form.metodi_pagamento.join(', ')}</div>
            </div>
          </div>
          <div className="alert alert-success" style={{ marginTop: 16 }}>Il modulo di iscrizione sarà immediatamente disponibile dopo la creazione.</div>
        </>}
        <div className="modal-footer">
          {step > 0 && <button className="btn btn-ghost" onClick={() => setStep(s => s - 1)}>← Indietro</button>}
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          {step < steps.length - 1
            ? <button className="btn btn-primary" onClick={() => setStep(s => s + 1)}>Avanti →</button>
            : <button className="btn btn-success" onClick={crea} disabled={saving}>{saving ? <><span className="spinner" /> Creazione...</> : '✅ Crea evento'}</button>
          }
        </div>
      </div>
    </div>
  )
}

function ModalEditEvento({ evento, onClose, user }) {
  const [tab, setTab] = useState('base')
  const [form, setForm] = useState({
    nome: evento.nome, descrizione: evento.descrizione || '',
    data_inizio: evento.data_inizio, data_fine: evento.data_fine,
    quota_base: evento.quota_base, prezzo_settimana: evento.prezzo_settimana,
    prezzo_giornata: evento.prezzo_giornata, sconto_fratelli: evento.sconto_fratelli,
    servizi: evento.servizi || [],
    campi_extra: evento.campi_extra || [],
    metodi_pagamento: evento.metodi_pagamento || ['Contanti', 'POS/Carta', 'Bonifico'],
    campi_base: evento.campi_base || { // campi base opzionali (valori di default se non presenti)
      nome_bambino: true, cognome_bambino: true, data_nascita: false, comune_residenza: false,
      nome_genitore: true, cognome_genitore: true, email_genitore: true, telefono_genitore: true,
      settimane: true, servizi: true, mensa: true, is_fratello: false, note: false,
      consenso_privacy: true, consenso_foto: false, consenso_regolamento: false,
    },
  })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const TUTTI_METODI = ['Contanti', 'POS/Carta', 'Bonifico']

  const salva = async () => {
    setSaving(true)
    try {
      const { error } = await supabase.from('eventi').update(form).eq('id', evento.id)
      if (error) {
        alert('Errore nel salvataggio evento: ' + error.message)
        setSaving(false)
        return
      }
      logAudit({ user, azione: 'MODIFICA_EVENTO', categoria: 'Eventi',
        dettaglio: `Modificato evento "${form.nome}"`,
        meta: { evento_id: evento.id, nome: form.nome } })
      setSaving(false); onClose()
    } catch (err) {
      alert('Errore nel salvataggio evento: ' + err.message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">✏️ Modifica: {evento.nome}</div>
        <div className="tabs" style={{ marginBottom: 20 }}>
          {[['base','📋 Dati base'],['servizi','🛒 Servizi'],['pagamenti','💳 Pagamento'],['campibase','⚙️ Campi Base'],['campi','➕ Campi Extra']].map(([t,l]) => (
            <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
          ))}
        </div>
        {tab === 'base' && <>
          <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={form.nome} onChange={e => set('nome', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Descrizione</label><textarea className="form-textarea" value={form.descrizione} onChange={e => set('descrizione', e.target.value)} /></div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Data inizio</label><input className="form-input" type="date" value={form.data_inizio} onChange={e => set('data_inizio', e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Data fine</label><input className="form-input" type="date" value={form.data_fine} onChange={e => set('data_fine', e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Quota base (€)</label><input className="form-input" type="number" value={form.quota_base} onChange={e => set('quota_base', +e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Prezzo settimana (€)</label><input className="form-input" type="number" value={form.prezzo_settimana} onChange={e => set('prezzo_settimana', +e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Prezzo giornata (€)</label><input className="form-input" type="number" value={form.prezzo_giornata} onChange={e => set('prezzo_giornata', +e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Sconto fratelli (€)</label><input className="form-input" type="number" value={form.sconto_fratelli} onChange={e => set('sconto_fratelli', +e.target.value)} /></div>
          </div>
        </>}
        {tab === 'servizi' && <>
          <p style={{ color: 'var(--text-muted)', marginBottom: 12, fontSize: '.9rem' }}>Servizi aggiuntivi visibili nel modulo di iscrizione:</p>
          {form.servizi.map((s, i) => (
            <div key={s.id || i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input className="form-input" value={s.nome} onChange={e => set('servizi', form.servizi.map((x, j) => j === i ? { ...x, nome: e.target.value } : x))} />
              <input className="form-input" type="number" value={s.prezzo} style={{ width: 100 }} onChange={e => set('servizi', form.servizi.map((x, j) => j === i ? { ...x, prezzo: +e.target.value } : x))} />
              <button className="btn btn-sm btn-danger" onClick={() => set('servizi', form.servizi.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => set('servizi', [...form.servizi, { id: uid(), nome: '', prezzo: 0 }])}>+ Aggiungi servizio</button>
        </>}
        {tab === 'pagamenti' && <>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: '.9rem' }}>Metodi di pagamento accettati (il genitore vedrà solo quelli selezionati):</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            {TUTTI_METODI.map(m => (
              <button key={m} type="button"
                className={`btn ${form.metodi_pagamento.includes(m) ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => set('metodi_pagamento', form.metodi_pagamento.includes(m) ? form.metodi_pagamento.filter(x => x !== m) : [...form.metodi_pagamento, m])}>
                {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
              </button>
            ))}
          </div>
        </>}
        {tab === 'campibase' && <>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            Seleziona quali campi base mostrare nel modulo di iscrizione pubblico. I campi selezionati saranno obbligatori.
          </div>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>👦 Dati bambino</div>
            <div className="check-group">
              {[
                { key: 'nome_bambino', label: 'Nome bambino' },
                { key: 'cognome_bambino', label: 'Cognome bambino' },
                { key: 'data_nascita', label: 'Data di nascita' },
                { key: 'comune_residenza', label: 'Comune di residenza' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>👨‍👩‍👧 Dati genitore</div>
            <div className="check-group">
              {[
                { key: 'nome_genitore', label: 'Nome genitore' },
                { key: 'cognome_genitore', label: 'Cognome genitore' },
                { key: 'email_genitore', label: 'Email genitore' },
                { key: 'telefono_genitore', label: 'Telefono genitore' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>📅 Iscrizione</div>
            <div className="check-group">
              {[
                { key: 'settimane', label: 'Settimane di partecipazione' },
                { key: 'servizi', label: 'Servizi aggiuntivi' },
                { key: 'mensa', label: 'Servizio mensa (se presente)' },
                { key: 'is_fratello', label: 'Sconto fratello/sorella' },
                { key: 'note', label: 'Note aggiuntive' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>✅ Consensi</div>
            <div className="check-group">
              {[
                { key: 'consenso_privacy', label: 'Consenso privacy (GDPR)' },
                { key: 'consenso_foto', label: 'Consenso pubblicazione foto' },
                { key: 'consenso_regolamento', label: 'Accettazione regolamento' },
              ].map(campo => (
                <label key={campo.key} className={`check-item ${form.campi_base[campo.key] ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.campi_base[campo.key]} 
                    onChange={e => set('campi_base', { ...form.campi_base, [campo.key]: e.target.checked })} />
                  <span>{campo.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>}
        {tab === 'campi' && <>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            I campi extra appaiono nel modulo pubblico di iscrizione. I dati inseriti dai genitori vengono salvati e visibili nell'elenco iscritti.
          </div>
          <EditorCampiExtra campi={form.campi_extra} onChange={v => set('campi_extra', v)} />
        </>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={salva} disabled={saving}>{saving ? <><span className="spinner" /> Salvataggio...</> : '💾 Salva'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── PUBLIC: EVENTO ───────────────────────────────────────────────────────────
function PubEventoForm({ eventoId, onBack, authUser, profilo }) {
  const [evento, setEvento] = useState(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState(0)
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    nome_bambino: '', cognome_bambino: '', data_nascita: '', comune_residenza: '',
    nome_genitore: '', cognome_genitore: '', email_genitore: '', telefono_genitore: '',
    settimane: [], servizi: [], mensa_settimane: [], is_fratello: false, note: '',
    consenso_privacy: false, consenso_foto: false, consenso_regolamento: false,
    dati_extra: {},
    metodo_pagamento: '',
  })
  const [showPwdGenitore, setShowPwdGenitore] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const toggle = (k, val) => setForm(p => ({ ...p, [k]: p[k].includes(val) ? p[k].filter(x => x !== val) : [...p[k], val] }))
  const setExtra = (id, val) => setForm(p => ({ ...p, dati_extra: { ...p.dati_extra, [id]: val } }))

  useEffect(() => {
    supabase.from('eventi').select('*').eq('id', eventoId).single()
      .then(({ data }) => { setEvento(data); setLoading(false) })
    // Pre-compila dati genitore dall'account loggato
    if (authUser && profilo) {
      setForm(p => ({
        ...p,
        nome_genitore:     profilo.nome    || '',
        cognome_genitore:  profilo.cognome || '',
        email_genitore:    authUser.email  || '',
        telefono_genitore: profilo.telefono || '',
      }))
    }
  }, [eventoId, authUser, profilo]) // eslint-disable-line

  if (loading) return <div className="public-page"><LoadingPage text="Caricamento evento..." /></div>
  if (!evento) return <div className="public-page"><div className="alert alert-danger">Evento non trovato.</div><button className="btn btn-ghost" onClick={onBack}>← Indietro</button></div>

  const settimane = getWeeksInRange(evento.data_inizio, evento.data_fine)

  const mensaServizio = (evento.servizi || []).find(s => s.nome?.toLowerCase().includes('mensa'))
  const isMensaService = (s) => s.nome?.toLowerCase().includes('mensa')
  const PREZZO_MENSA_SETTIMANA = 5

  const calcTotale = () => {
    let tot = +evento.quota_base || 0
    tot += form.settimane.length * (+evento.prezzo_settimana || 0)
    // servizi NON-mensa: prezzo piatto
    ;(evento.servizi || []).forEach(s => {
      if (!isMensaService(s) && form.servizi.includes(s.id)) tot += +s.prezzo
    })
    // mensa: 5€ per ogni settimana selezionata
    tot += (form.mensa_settimane || []).length * PREZZO_MENSA_SETTIMANA
    if (form.is_fratello) tot -= +evento.sconto_fratelli || 0
    return Math.max(0, tot)
  }

  const stepNames = ['👦 Bambino', '👨‍👩‍👧 Genitore', '📅 Iscrizione', '✅ Consensi']

  const invia = async () => {
    setSaving(true)
    const pwdHash = null  // credenziali gestite da Supabase Auth
    const dati = {
      ...form,
      evento_id: evento.id,
      totale: calcTotale(),
      email_genitore: (form.email_genitore || '').trim().toLowerCase(),
      saldato: false,
      utente_id: authUser?.id || null
    }
    const { error: errIscr } = await supabase.from('iscrizioni').insert([dati])
    if (errIscr) { alert('Errore nell\'iscrizione: ' + errIscr.message); setSaving(false); return }
    logAudit({ user: { nome: `${dati.nome_genitore || ''} ${dati.cognome_genitore || ''}`.trim(), email: dati.email_genitore || '', id: null },
      azione: 'NUOVA_ISCRIZIONE', categoria: 'Iscrizioni',
      dettaglio: `Nuova iscrizione: ${dati.nome_bambino} ${dati.cognome_bambino} a "${evento.nome}" — ${fmt(dati.totale)}`,
      meta: { nome_bambino: dati.nome_bambino, cognome_bambino: dati.cognome_bambino,
        evento_id: dati.evento_id, totale: dati.totale } })
    sendPushNotification({
      titolo: '📋 Nuova iscrizione',
      corpo:  `${dati.nome_bambino} ${dati.cognome_bambino} si è iscritto/a a "${evento.nome}"`,
      target_tipo: 'superadmin',
    })
    setSaving(false); setSuccess(true)
  }

  const resetForm = () => {
    setSuccess(false); setStep(0)
    setForm({ nome_bambino: '', cognome_bambino: '', data_nascita: '', comune_residenza: '', nome_genitore: '', cognome_genitore: '', email_genitore: '', telefono_genitore: '', settimane: [], servizi: [], mensa_settimane: [], is_fratello: false, note: '', consenso_privacy: false, consenso_foto: false, consenso_regolamento: false, dati_extra: {}, metodo_pagamento: '' })
  }

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>🎉</div>
      <h2 style={{ color: 'var(--primary)', marginBottom: 8 }}>Iscrizione inviata!</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>Grazie! Iscrizione per <b>{evento.nome}</b> registrata correttamente.</p>
      <div className="price-box" style={{ maxWidth: 300, margin: '0 auto 24px' }}>
        <div className="price-total">{fmt(calcTotale())}</div>
        <div className="price-breakdown">Totale da versare</div>
      </div>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        <button className="btn btn-primary btn-lg" onClick={resetForm}>+ Nuova iscrizione</button>
        {authUser && <button className="btn btn-success btn-lg" onClick={() => { onBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('goto-area-personale')), 100) }}>👤 La mia area →</button>}
        <button className="btn btn-ghost btn-lg" onClick={onBack}>← Home</button>
      </div>
    </div></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <img src="/logo-oratorio.png" alt="Logo Oratorio" style={{ width: 120, height: 'auto', objectFit: 'contain', marginBottom: 8 }} />
        <h1>Iscrizione: {evento.nome}</h1>
        <p>📅 {evento.data_inizio} → {evento.data_fine} · Oratorio di Sergnano</p>
        {evento.descrizione && <p style={{ marginTop: 8, fontStyle: 'italic' }}>{evento.descrizione}</p>}
      </div>
      <BannerUtente authUser={authUser} profilo={profilo} />
      <div className="steps">
        {stepNames.map((s, i) => (
          <div key={i} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
            <div className="step-num">{i < step ? '✓' : i + 1}</div>
            <div className="step-label">{s}</div>
          </div>
        ))}
      </div>
      <div className="card">
        {step === 0 && <>
          <h3 style={{ marginBottom: 20, color: 'var(--primary)' }}>👦 Dati del bambino/ragazzo</h3>
          <div className="form-row">
            {evento.campi_base?.nome_bambino && (
              <div className="form-group"><label className="form-label">Nome *</label><input className="form-input" value={form.nome_bambino} onChange={e => set('nome_bambino', e.target.value)} /></div>
            )}
            {evento.campi_base?.cognome_bambino && (
              <div className="form-group"><label className="form-label">Cognome *</label><input className="form-input" value={form.cognome_bambino} onChange={e => set('cognome_bambino', e.target.value)} /></div>
            )}
          </div>
          <div className="form-row">
            {evento.campi_base?.data_nascita && (
              <div className="form-group"><label className="form-label">Data di nascita</label><input className="form-input" type="date" value={form.data_nascita} onChange={e => set('data_nascita', e.target.value)} /></div>
            )}
            {evento.campi_base?.comune_residenza && (
              <div className="form-group"><label className="form-label">Comune di residenza</label><input className="form-input" value={form.comune_residenza} onChange={e => set('comune_residenza', e.target.value)} /></div>
            )}
          </div>
          {/* Campi extra configurati dall'admin */}
          {(evento.campi_extra || []).length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>Informazioni aggiuntive richieste dall'evento</div>
              {(evento.campi_extra || []).map(campo => (
                <CampoExtra
                  key={campo.id}
                  campo={campo}
                  value={form.dati_extra[campo.id]}
                  onChange={val => setExtra(campo.id, val)}
                />
              ))}
            </div>
          )}
          {evento.campi_base?.is_fratello && (
            <label className={`check-item ${form.is_fratello ? 'checked' : ''}`} style={{ marginTop: 8 }}>
              <input type="checkbox" checked={form.is_fratello} onChange={e => set('is_fratello', e.target.checked)} />
              <span>Sconto fratello/sorella (-{fmt(evento.sconto_fratelli || 0)})</span>
            </label>
          )}
        </>}
        {step === 1 && <>
          <h3 style={{ marginBottom: 20, color: 'var(--primary)' }}>👨‍👩‍👧 Dati del genitore/tutore</h3>
          <div className="form-row">
            {evento.campi_base?.nome_genitore && (
              <div className="form-group"><label className="form-label">Nome *</label><input className="form-input" value={form.nome_genitore} onChange={e => set('nome_genitore', e.target.value)} /></div>
            )}
            {evento.campi_base?.cognome_genitore && (
              <div className="form-group"><label className="form-label">Cognome *</label><input className="form-input" value={form.cognome_genitore} onChange={e => set('cognome_genitore', e.target.value)} /></div>
            )}
          </div>
          <div className="form-row">
            {evento.campi_base?.email_genitore && (
              <div className="form-group"><label className="form-label">Email *</label><input className="form-input" type="email" value={form.email_genitore} onChange={e => set('email_genitore', e.target.value)} /></div>
            )}
            {evento.campi_base?.telefono_genitore && (
              <div className="form-group"><label className="form-label">Telefono *</label><input className="form-input" type="tel" value={form.telefono_genitore} onChange={e => set('telefono_genitore', e.target.value)} /></div>
            )}
          </div>
                    {authUser ? (
            /* Utente loggato: l'iscrizione viene collegata all'account */
            <div style={{ background: 'var(--secondary-pale)', border: '1.5px solid var(--secondary)',
              borderRadius: 12, padding: 16, marginTop: 8 }}>
              <div style={{ fontWeight: 800, fontSize: '.9rem', marginBottom: 4, color: '#1a6b66' }}>
                ✅ Account collegato
              </div>
              <div style={{ fontSize: '.82rem', color: '#2a9d8f', lineHeight: 1.5 }}>
                L'iscrizione sarà collegata al tuo account <b>{authUser.email}</b>.
                Potrai consultare presenze, buoni pasto e comunicazioni dalla tua area personale.
              </div>
            </div>
          ) : (
            /* Utente non loggato: invito + credenziali legacy */
            <>
              <div style={{ background: '#fff8e1', border: '1.5px solid var(--accent)',
                borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: '.85rem', color: '#8a5c00', marginBottom: 4 }}>
                  💡 Hai già un account?
                </div>
                <div style={{ fontSize: '.78rem', color: '#8a5c00', lineHeight: 1.5, marginBottom: 10 }}>
                  Accedi prima di iscriverti per collegare automaticamente questa iscrizione al tuo
                  account e accedere alla tua area personale.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm"
                    onClick={() => window.dispatchEvent(new CustomEvent('goto-login-utente'))}>
                    🔓 Accedi
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => window.dispatchEvent(new CustomEvent('goto-registrazione'))}>
                    ✏️ Registrati
                  </button>
                </div>
              </div>
            </>
          )}
        </>}
        {step === 2 && <>
          <h3 style={{ marginBottom: 20, color: 'var(--primary)' }}>📅 Settimane e servizi</h3>
          {evento.campi_base?.settimane && settimane.length > 0 && <>
            <div className="form-label" style={{ marginBottom: 8 }}>Settimane di partecipazione</div>
            <div className="check-group" style={{ marginBottom: 20 }}>
              {settimane.map(s => (
                <label key={s.id} className={`check-item ${form.settimane.includes(s.id) ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.settimane.includes(s.id)} onChange={() => toggle('settimane', s.id)} />
                  <span>{s.label} — <b>{fmt(evento.prezzo_settimana || 0)}</b></span>
                </label>
              ))}
            </div>
          </>}
          {evento.campi_base?.servizi && (evento.servizi || []).length > 0 && <>
            <div className="form-label" style={{ marginBottom: 8 }}>Servizi aggiuntivi</div>
            <div className="check-group" style={{ marginBottom: 20 }}>
              {evento.servizi.filter(s => !isMensaService(s)).map(s => (
                <label key={s.id} className={`check-item ${form.servizi.includes(s.id) ? 'checked' : ''}`}>
                  <input type="checkbox" checked={form.servizi.includes(s.id)} onChange={() => toggle('servizi', s.id)} />
                  <span>{s.nome} — <b>{fmt(s.prezzo)}</b></span>
                </label>
              ))}
            </div>
          </>}
          {evento.campi_base?.mensa && mensaServizio && settimane.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div className="form-label" style={{ marginBottom: 4 }}>🍽️ Servizio Mensa</div>
              <div style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                Seleziona le settimane in cui il bambino usufruirà della mensa — <b>€{PREZZO_MENSA_SETTIMANA} per settimana</b>
              </div>
              <div className="check-group">
                {settimane.map(s => {
                  const sel = (form.mensa_settimane || []).includes(s.id)
                  return (
                    <label key={s.id} className={`check-item ${sel ? 'checked' : ''}`}
                      style={{ borderColor: sel ? '#e67e22' : undefined, background: sel ? '#fff8e1' : undefined }}>
                      <input type="checkbox" checked={sel}
                        onChange={() => setForm(p => ({
                          ...p,
                          mensa_settimane: sel
                            ? p.mensa_settimane.filter(x => x !== s.id)
                            : [...(p.mensa_settimane || []), s.id]
                        }))} />
                      <span>🍽️ {s.label} — <b>€{PREZZO_MENSA_SETTIMANA}</b></span>
                    </label>
                  )
                })}
              </div>
              {(form.mensa_settimane || []).length > 0 && (
                <div style={{ marginTop: 8, padding: '8px 14px', background: '#fff8e1', borderRadius: 8, fontSize: '.85rem', color: '#e65100', fontWeight: 700 }}>
                  🍽️ Mensa selezionata per {form.mensa_settimane.length} settimane → {fmt((form.mensa_settimane || []).length * PREZZO_MENSA_SETTIMANA)}
                </div>
              )}
            </div>
          )}
          {evento.campi_base?.note && (
            <div className="form-group"><label className="form-label">Note aggiuntive</label><textarea className="form-textarea" value={form.note} onChange={e => set('note', e.target.value)} placeholder="Allergie, esigenze particolari..." /></div>
          )}
          {(evento.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).length > 0 && (
            <div className="form-group">
              <label className="form-label">Metodo di pagamento *</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {(evento.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).map(m => (
                  <button key={m} type="button"
                    className={`btn ${form.metodo_pagamento === m ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => set('metodo_pagamento', m)}>
                    {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="price-box">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Riepilogo costi</div>
            <div className="price-breakdown" style={{ lineHeight: 1.8 }}>
              <div>Quota base: {fmt(evento.quota_base || 0)}</div>
              {evento.campi_base?.settimane && form.settimane.length > 0 && <div>Settimane ({form.settimane.length}): +{fmt(form.settimane.length * (evento.prezzo_settimana || 0))}</div>}
              {evento.campi_base?.mensa && (form.mensa_settimane||[]).length > 0 && <div>Mensa ({form.mensa_settimane.length} sett.): +{fmt(form.mensa_settimane.length * PREZZO_MENSA_SETTIMANA)}</div>}
              {evento.campi_base?.servizi && form.servizi.length > 0 && <div>Servizi extra: +{fmt((evento.servizi||[]).filter(s => !isMensaService(s) && form.servizi.includes(s.id)).reduce((a,s) => a + +s.prezzo, 0))}</div>}
              {evento.campi_base?.is_fratello && form.is_fratello && <div>Sconto fratello: −{fmt(evento.sconto_fratelli || 0)}</div>}
            </div>
            <div className="price-total">{fmt(calcTotale())}</div>
          </div>
        </>}
        {step === 3 && <>
          <h3 style={{ marginBottom: 20, color: 'var(--primary)' }}>✅ Consensi e invio</h3>
          <div className="check-group">
            {evento.campi_base?.consenso_privacy && (
              <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`}>
                <input type="checkbox" checked={form.consenso_privacy} onChange={e => set('consenso_privacy', e.target.checked)} />
                <span>Acconsento al trattamento dei dati personali ai sensi del GDPR *</span>
              </label>
            )}
            {evento.campi_base?.consenso_foto && (
              <label className={`check-item ${form.consenso_foto ? 'checked' : ''}`}>
                <input type="checkbox" checked={form.consenso_foto} onChange={e => set('consenso_foto', e.target.checked)} />
                <span>Autorizzo la pubblicazione di foto/video del minore *</span>
              </label>
            )}
            {evento.campi_base?.consenso_regolamento && (
              <label className={`check-item ${form.consenso_regolamento ? 'checked' : ''}`}>
                <input type="checkbox" checked={form.consenso_regolamento} onChange={e => set('consenso_regolamento', e.target.checked)} />
                <span>Dichiaro di aver letto e accettato il regolamento dell'oratorio *</span>
              </label>
            )}
          </div>
          <div className="price-box" style={{ marginTop: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Totale iscrizione</div>
            <div className="price-total">{fmt(calcTotale())}</div>
          </div>
        </>}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', marginTop: 24 }}>
          <button className="btn btn-ghost" onClick={step === 0 ? onBack : () => setStep(s => s - 1)}>← Indietro</button>
          {step < stepNames.length - 1
            ? <button className="btn btn-primary btn-lg"
                onClick={() => setStep(s => s + 1)}
                disabled={false}>
                Continua →
              </button>
            : <button className="btn btn-success btn-lg" onClick={invia}
                disabled={saving || (evento.campi_base?.consenso_privacy && !form.consenso_privacy)}>
                {saving ? <><span className="spinner" /> Invio...</> : '📩 Invia iscrizione'}
              </button>
          }
        </div>
      </div>
    </div>
  )
}


// ─── NOTE MODAL PRENOTAZIONI ──────────────────────────────────────────────────
function NoteModal({ tabella, prenotazione, user, onClose }) {
  const [nota,      setNota]    = useState('')
  const [loading,   setLoading] = useState(true)
  const [saving,    setSaving]  = useState(false)

  // Carica SEMPRE la nota fresca dal DB all'apertura del modal
  // (evita di mostrare dato stale dalla memoria React)
  useEffect(() => {
    supabase.from(tabella).select('note_admin').eq('id', prenotazione.id).single()
      .then(({ data }) => {
        setNota(data?.note_admin || '')
        setLoading(false)
      })
      .catch(() => {
        setNota(prenotazione.note_admin || '')
        setLoading(false)
      })
  }, [prenotazione.id]) // eslint-disable-line

  const salva = async () => {
    setSaving(true)
    const { error } = await supabase
      .from(tabella)
      .update({ note_admin: nota.trim() || null })
      .eq('id', prenotazione.id)
    if (error) {
      alert('Errore salvataggio nota: ' + error.message)
      setSaving(false)
      return
    }
    logAudit({ user, azione: 'NOTE_PRENOTAZIONE', categoria: 'Prenotazioni',
      dettaglio: `Nota aggiornata su prenotazione in ${tabella}`,
      meta: { tabella, id: prenotazione.id } })
    setSaving(false)
    onClose()
  }

  const nomePrenotante = prenotazione.nome || prenotazione.referente || prenotazione.chi || '—'
  const dataInfo = prenotazione.data || prenotazione.arrivo || '—'

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-title">📝 Note interne — {nomePrenotante}</div>
        <div style={{ fontSize: '.83rem', color: 'var(--text-muted)', marginBottom: 14 }}>
          📅 {dataInfo} · <span style={{ color: '#8e44ad', fontWeight: 700 }}>Visibili solo agli admin</span>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div className="spinner" style={{ width: 24, height: 24, borderWidth: 3,
              borderColor: 'rgba(226,91,69,.15)', borderTopColor: 'var(--primary)', margin: '0 auto' }} />
            <div style={{ marginTop: 8, fontSize: '.83rem', color: 'var(--text-muted)' }}>
              Caricamento nota...
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">Nota privata</label>
              <textarea
                className="form-textarea"
                rows={4}
                value={nota}
                onChange={e => setNota(e.target.value)}
                placeholder="es. Ha chiesto uno sconto, da richiamare, pagamento in sospeso..."
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {['📞 Da richiamare','💰 Sconto richiesto','✅ Pagato','⚠️ Da verificare','❌ Cancellare'].map(tag => (
                <button key={tag} type="button"
                  onClick={() => setNota(p => p ? p + '\n' + tag : tag)}
                  style={{ padding: '4px 10px', borderRadius: 20, border: '1.5px solid var(--border)',
                    background: '#fff', fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
                    color: 'var(--text-muted)' }}>
                  {tag}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="modal-footer">
          {!loading && nota && (
            <button className="btn btn-ghost btn-sm" style={{ marginRight: 'auto', color: 'var(--danger)' }}
              onClick={() => setNota('')}>🗑️ Cancella nota</button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Chiudi</button>
          {!loading && (
            <button className="btn btn-primary" onClick={salva} disabled={saving}>
              {saving ? <><span className="spinner" /> Salvo...</> : '💾 Salva nota'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}


// ─── AREA PERSONALE UTENTE ────────────────────────────────────────────────────
function AreaPersonale({ authUser, profilo, goTo, onBack, onLogout }) {
  const [tab,           setTab]           = useState('dashboard')
  const [prenotazioni,  setPrenotazioni]  = useState([])
  const [iscrizioni,    setIscrizioni]    = useState([])
  const [comunicazioni, setComunicazioni] = useState([])
  const [datiIscrizioni,setDatiIscrizioni]= useState({}) // {id: {buoni, presenze, appello}}
  const [loading,       setLoading]       = useState(true)

  useEffect(() => {
    const carica = async () => {
      setLoading(true)
      console.log('🔍 Caricamento Area Personale per:', authUser.email, authUser.id)
      
      try {
        // 1. Carica prenotazioni
        const [camp, sala, app, aule] = await Promise.all([
          supabase.from('prenotazioni_campetto').select('*').eq('utente_id', authUser.id).order('data', { ascending: false }),
          supabase.from('prenotazioni_sala').select('*').eq('utente_id', authUser.id).order('data', { ascending: false }),
          supabase.from('prenotazioni_appartamento').select('*').eq('utente_id', authUser.id).order('arrivo', { ascending: false }),
          supabase.from('prenotazioni_aule').select('*').eq('utente_id', authUser.id).order('data', { ascending: false }),
        ])

        // 2. Carica iscrizioni (tentativo 1: per utente_id)
        // Specifichiamo la relazione esatta evento_id per evitare ambiguità nel join
        let { data: iscrData, error: iscrErr } = await supabase
          .from('iscrizioni')
          .select('*, eventi!evento_id(nome,data_inizio,data_fine)')
          .eq('utente_id', authUser.id)
          .order('created_at', { ascending: false })

        if (iscrErr) console.error('❌ Errore query utente_id:', iscrErr.message)
        console.log('📊 Iscrizioni per utente_id:', iscrData?.length || 0)

        // Se vuoto, tentativo 2: per email
        if (!iscrData || iscrData.length === 0) {
          console.log('📧 Nessuna iscrizione per ID, provo per email:', authUser.email)
          const { data: iscrEmail, error: errEmail } = await supabase
            .from('iscrizioni')
            .select('*, eventi!evento_id(nome,data_inizio,data_fine)')
            .ilike('email_genitore', authUser.email.trim())
            .order('created_at', { ascending: false })
          
          if (errEmail) console.error('❌ Errore query email:', errEmail.message)
          if (iscrEmail) iscrData = iscrEmail
          console.log('📊 Iscrizioni per email:', iscrData?.length || 0)
        }

        // TENTATIVO 3: Debug estremo (tutte le iscrizioni dell'utente senza join)
        if (!iscrData || iscrData.length === 0) {
          console.log('🧪 Tentativo di emergenza: query senza join...')
          const { data: debugIscr, error: debugErr } = await supabase
            .from('iscrizioni')
            .select('id, utente_id, email_genitore')
            .or(`utente_id.eq.${authUser.id},email_genitore.eq.${authUser.email}`)
          
          if (debugErr) console.error('❌ Errore debug query:', debugErr.message)
          console.log('📊 Risultato query emergenza:', debugIscr?.length || 0, debugIscr)
        }

        const tuttePren = [
          ...(camp.data||[]).map(p => ({ ...p, tipo: 'campetto', icona: '⚽', label: 'Campetto' })),
          ...(sala.data||[]).map(p => ({ ...p, tipo: 'sala', icona: '🎉', label: 'Sala Feste' })),
          ...(app.data||[]).map(p => ({ ...p, tipo: 'appartamento', icona: '🏡', label: 'Appartamento', data: p.arrivo })),
          ...(aule.data||[]).map(p => ({ ...p, tipo: 'aule', icona: '🏫', label: 'Aula: ' + p.aula })),
        ].sort((a, b) => (b.data || '').localeCompare(a.data || ''))
        
        setPrenotazioni(tuttePren)
        const iscrizioniCaricate = iscrData || []
        setIscrizioni(iscrizioniCaricate)

        // Carica comunicazioni e altri dati...
        const eventoIds = [...new Set(iscrizioniCaricate.map(i => i.evento_id).filter(Boolean))]
        if (eventoIds.length > 0) {
          const { data: comms } = await supabase
            .from('comunicazioni_inviate').select('*')
            .in('evento_id', eventoIds)
            .order('inviata_il', { ascending: false })
          setComunicazioni(comms || [])
        }

        const dati = {}
        await Promise.all(iscrizioniCaricate.map(async (i) => {
          const [buoniRes, appelloRes] = await Promise.all([
            supabase.from('buoni_pasto').select('quantita').eq('iscrizione_id', i.id).eq('evento_id', i.evento_id).maybeSingle(),
            supabase.from('appello_giornaliero').select('data, presenza, pranzo').eq('iscrizione_id', i.id).order('data', { ascending: false }),
          ])
          dati[i.id] = { buoni: buoniRes.data?.quantita ?? null, appello: appelloRes.data || [] }
        }))
        setDatiIscrizioni(dati)
      } catch (err) {
        console.error('❌ Errore critico Area Personale:', err)
      } finally {
        setLoading(false)
      }
    }
    carica()
  }, [authUser.id, authUser.email])

  const oggi = new Date().toISOString().split('T')[0]
  const prenFuture  = prenotazioni.filter(p => (p.data || p.arrivo || '') >= oggi)
  const prenPassate = prenotazioni.filter(p => (p.data || p.arrivo || '') < oggi)
  const buoniTotali = Object.values(datiIscrizioni).reduce((s, d) => s + (d.buoni || 0), 0)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg,#E25B45,#FF8357)',
        padding: '28px 24px 20px', color: '#fff',
      }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
            <div>
              <div style={{ fontSize:'.75rem', opacity:.7, marginBottom:4 }}>
                <button onClick={onBack}
                  style={{ background:'none',border:'none',color:'rgba(255,255,255,.7)',
                    cursor:'pointer',fontSize:'.75rem',padding:0 }}>
                  ← Home
                </button>
              </div>
              <h1 style={{ fontFamily:'Nunito,sans-serif', fontWeight:900, fontSize:'1.6rem', marginBottom:3 }}>
                Ciao, {profilo?.nome || authUser.email.split('@')[0]}! 👋
              </h1>
              <div style={{ opacity:.8, fontSize:'.85rem' }}>{authUser.email}</div>
            </div>
            <button onClick={onLogout}
              style={{ background:'rgba(255,255,255,.15)', border:'1.5px solid rgba(255,255,255,.3)',
                borderRadius:10, padding:'8px 16px', color:'#fff', fontSize:'.82rem',
                fontWeight:600, cursor:'pointer' }}>
              🚪 Esci
            </button>
          </div>
          {/* Mini stats */}
          <div style={{ display:'flex', gap:12, marginTop:20, flexWrap:'wrap' }}>
            {[
              { val: prenFuture.length,                              label: 'Prenotazioni attive',  icon: '📅' },
              { val: iscrizioni.length,                              label: 'Iscrizioni eventi',    icon: '🎪' },
              { val: comunicazioni.length,                           label: 'Comunicazioni',         icon: '📣' },
              ...(buoniTotali > 0 ? [{ val: buoniTotali, label: 'Buoni pasto', icon: '🎟️' }] : []),
            ].map(s => (
              <div key={s.label} style={{ background:'rgba(255,255,255,.15)', borderRadius:10,
                padding:'10px 16px', display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:'1.3rem' }}>{s.icon}</span>
                <div>
                  <div style={{ fontWeight:900, fontSize:'1.2rem', fontFamily:'Nunito,sans-serif' }}>{s.val}</div>
                  <div style={{ fontSize:'.7rem', opacity:.8 }}>{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ maxWidth:860, margin:'0 auto', padding:'20px 16px' }}>
        <div className="tabs" style={{ marginBottom:24 }}>
          {[
            ['dashboard', '🏠 Riepilogo'],
            ['prenotazioni', '📅 Prenotazioni'],
            ['iscrizioni', '🎪 Iscrizioni'],
            ['comunicazioni', '📣 Comunicazioni' + (comunicazioni.length > 0 ? ` (${comunicazioni.length})` : '')],
            ['profilo', '👤 Profilo'],
          ].map(([id, label]) => (
            <div key={id} className={`tab ${tab===id?'active':''}`} onClick={() => setTab(id)}>
              {label}
            </div>
          ))}
        </div>

        {loading ? <LoadingPage text="Caricamento..." /> : (<>

          {/* ── DASHBOARD ── */}
          {tab === 'dashboard' && (
            <div>
              {/* Prossime prenotazioni */}
              <div className="card" style={{ marginBottom:16 }}>
                <div className="card-header">
                  <div className="card-title">📅 Prossime prenotazioni</div>
                  <button className="btn btn-sm btn-ghost" onClick={() => setTab('prenotazioni')}>Vedi tutte →</button>
                </div>
                {prenFuture.length === 0
                  ? <div className="alert alert-info">Nessuna prenotazione futura.
                      <button className="btn btn-sm btn-primary" style={{marginLeft:12}}
                        onClick={onBack}>Prenota →</button>
                    </div>
                  : prenFuture.slice(0,3).map(p => (
                    <PrenotazioneCard key={p.id} p={p} />
                  ))
                }
              </div>
              {/* Iscrizioni attive */}
              {iscrizioni.length > 0 && (
                <div className="card" style={{ marginBottom:16 }}>
                  <div className="card-header">
                    <div className="card-title">🎪 Le mie iscrizioni</div>
                    <button className="btn btn-sm btn-ghost" onClick={() => setTab('iscrizioni')}>Vedi tutte →</button>
                  </div>
                  {iscrizioni.slice(0,2).map(i => (
                    <IscrizioneCard key={i.id} i={i} goTo={goTo} />
                  ))}
                </div>
              )}
              {/* Ultime comunicazioni */}
              {comunicazioni.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">📣 Ultime comunicazioni</div>
                    <button className="btn btn-sm btn-ghost" onClick={() => setTab('comunicazioni')}>Vedi tutte →</button>
                  </div>
                  {comunicazioni.slice(0,2).map(c => {
                    let testo = c.messaggio
                    try { testo = JSON.parse(c.messaggio).testo || c.messaggio } catch {}
                    return (
                      <div key={c.id} style={{ padding:'10px 0', borderBottom:'1px solid var(--border-light)' }}>
                        <div style={{ fontWeight:700, fontSize:'.88rem', color:'var(--primary)', marginBottom:3 }}>
                          📣 {c.oggetto}
                        </div>
                        <div style={{ fontSize:'.78rem', color:'var(--text-muted)',
                          overflow:'hidden', display:'-webkit-box',
                          WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>
                          {testo}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── PRENOTAZIONI ── */}
          {tab === 'prenotazioni' && (
            <div>
              {prenFuture.length > 0 && (
                <div className="card" style={{ marginBottom:16 }}>
                  <div className="card-title" style={{ marginBottom:14 }}>📅 Future / Attive</div>
                  {prenFuture.map(p => <PrenotazioneCard key={p.id} p={p} />)}
                </div>
              )}
              {prenPassate.length > 0 && (
                <div className="card">
                  <div className="card-title" style={{ marginBottom:14, color:'var(--text-muted)' }}>
                    📋 Passate
                  </div>
                  {prenPassate.map(p => <PrenotazioneCard key={p.id} p={p} passata />)}
                </div>
              )}
              {prenotazioni.length === 0 && (
                <div className="alert alert-info">
                  Non hai ancora effettuato prenotazioni.
                  <button className="btn btn-sm btn-primary" style={{marginLeft:12}}
                    onClick={onBack}>Prenota ora →</button>
                </div>
              )}
            </div>
          )}

          {/* ── ISCRIZIONI ── */}
          {tab === 'iscrizioni' && (
            <div>
              {iscrizioni.length === 0
                ? <div className="alert alert-info">Nessuna iscrizione registrata.</div>
                : iscrizioni.map(i => (
                    <IscrizioneCardEstesa
                      key={i.id} i={i} goTo={goTo}
                      dati={datiIscrizioni[i.id]}
                    />
                  ))
              }
            </div>
          )}

          {/* ── COMUNICAZIONI ── */}
          {tab === 'comunicazioni' && (
            <div>
              {comunicazioni.length === 0 ? (
                <div className="alert alert-info">
                  Nessuna comunicazione dall'oratorio al momento.
                </div>
              ) : comunicazioni.map(c => {
                let testo = c.messaggio, imgSrc = null
                try { const p = JSON.parse(c.messaggio); testo = p.testo || c.messaggio; imgSrc = p.immagine || null } catch {}
                const evNome = iscrizioni.find(i => i.evento_id === c.evento_id)?.eventi?.nome || 'Evento'
                return (
                  <div key={c.id} style={{
                    background: '#fff', border: '1.5px solid var(--border)',
                    borderRadius: 14, padding: '16px 18px', marginBottom: 12,
                    boxShadow: 'var(--shadow)',
                  }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                      <div>
                        <div style={{ fontWeight:800, fontSize:'.95rem', color:'var(--primary)' }}>
                          📣 {c.oggetto}
                        </div>
                        <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginTop:2 }}>
                          🎪 {evNome}
                        </div>
                      </div>
                      <div style={{ fontSize:'.72rem', color:'var(--text-muted)', background:'var(--bg)',
                        padding:'2px 8px', borderRadius:20, whiteSpace:'nowrap' }}>
                        {new Date(c.inviata_il).toLocaleDateString('it', { day:'numeric', month:'short', year:'numeric' })}
                      </div>
                    </div>
                    <div style={{ fontSize:'.88rem', lineHeight:1.6, whiteSpace:'pre-wrap', color:'var(--text)' }}>
                      {testo}
                    </div>
                    {imgSrc && (
                      <img src={imgSrc} alt="allegato"
                        style={{ marginTop:10, maxWidth:'100%', borderRadius:10,
                          border:'1.5px solid var(--border)' }} />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── PROFILO ── */}
          {tab === 'profilo' && (
            <ProfiloTab authUser={authUser} profilo={profilo} />
          )}

        </>)}
      </div>
    </div>
  )
}

// Card singola prenotazione
function PrenotazioneCard({ p, passata }) {
  const dataLeggibile = p.data
    ? new Date(p.data + 'T12:00:00').toLocaleDateString('it', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
    : p.arrivo ? `${p.arrivo} → ${p.partenza}` : '—'

  return (
    <div style={{
      display:'flex', alignItems:'center', gap:14, padding:'12px 0',
      borderBottom:'1px solid var(--border-light)',
      opacity: passata ? .6 : 1,
    }}>
      <div style={{
        width:40, height:40, borderRadius:10, flexShrink:0,
        background: passata ? 'var(--bg)' : 'var(--primary-pale)',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:'1.2rem',
      }}>
        {p.icona}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:700, fontSize:'.9rem' }}>{p.label}</div>
        <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginTop:2 }}>
          📅 {dataLeggibile}
          {p.ora && ` · 🕐 ${p.ora}`}
          {p.durata && ` · ${p.durata}`}
        </div>
      </div>
      {p.prezzo > 0 && (
        <div style={{ fontWeight:800, color:'var(--primary)', fontSize:'.9rem', flexShrink:0 }}>
          €{Number(p.prezzo).toFixed(2)}
        </div>
      )}
    </div>
  )
}

// Card singola iscrizione evento
function IscrizioneCard({ i, goTo, expanded }) {
  const ev = i.eventi || {}
  return (
    <div style={{
      background:'var(--bg)', borderRadius:12, padding:'14px 16px', marginBottom:10,
      border:'1.5px solid var(--border)',
    }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontWeight:800, fontSize:'.95rem', marginBottom:3 }}>
            🎪 {ev.nome || 'Evento'}
          </div>
          <div style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>
            📅 {ev.data_inizio} → {ev.data_fine}
          </div>
          <div style={{ fontSize:'.82rem', marginTop:6 }}>
            👦 {i.nome_bambino} {i.cognome_bambino}
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontWeight:900, color:'var(--primary)', fontSize:'1.1rem' }}>
            €{Number(i.totale||0).toFixed(2)}
          </div>
          <span style={{
            background: i.saldato ? '#e8f5e9' : '#fff3e0',
            color: i.saldato ? '#2e7d32' : '#e65100',
            borderRadius:20, padding:'2px 10px', fontSize:'.72rem', fontWeight:700,
          }}>
            {i.saldato ? '✅ Saldato' : '⏳ Da saldare'}
          </span>
        </div>
      </div>
    </div>
  )
}

// Tab profilo utente
function ProfiloTab({ authUser, profilo }) {
  const [form,      setForm]      = useState({ nome: profilo?.nome||'', cognome: profilo?.cognome||'', telefono: profilo?.telefono||'' })
  const [saving,    setSaving]    = useState(false)
  const [msg,       setMsg]       = useState('')
  const [pwdForm,   setPwdForm]   = useState({ attuale: '', nuova: '', conferma: '' })
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdMsg,    setPwdMsg]    = useState('')
  const [pwdErr,    setPwdErr]    = useState('')
  const [showPwd,   setShowPwd]   = useState(false)
  const set    = (k, v) => setForm(p => ({...p, [k]: v}))
  const setPwd = (k, v) => setPwdForm(p => ({...p, [k]: v}))

  const salvaProfilo = async () => {
    if (!form.nome.trim() || !form.cognome.trim()) {
      setMsg('❌ Nome e cognome sono obbligatori.')
      return
    }
    setSaving(true)
    await supabase.from('profili').update({
      nome: form.nome.trim(), cognome: form.cognome.trim(),
      telefono: form.telefono.trim() || null
    }).eq('id', authUser.id)
    setSaving(false)
    setMsg('✅ Profilo aggiornato!')
    setTimeout(() => setMsg(''), 3000)
  }

  // Notifiche Area Personale
  const [pushStatus, setPushStatus] = useState(() => {
    if (typeof window === 'undefined') return 'idle'
    if (!('Notification' in window)) return 'unsupported'
    return Notification.permission === 'granted' ? 'ok' : 'idle'
  })

  const abilitaNotifiche = async () => {
    setPushStatus('loading')
    try {
      const sub = await initWebPush(authUser.id, 'genitore')
      setPushStatus(sub ? 'ok' : 'denied')
      if (sub) {
        setMsg('✅ Notifiche attivate su questo dispositivo!')
        setTimeout(() => setMsg(''), 4000)
      }
    } catch (e) {
      console.error('Errore abilitaNotifiche:', e)
      setPushStatus('denied')
    }
  }

  const cambiaPassword = async () => {
    setPwdErr(''); setPwdMsg('')
    if (!pwdForm.nuova || pwdForm.nuova.length < 8) {
      setPwdErr('La nuova password deve essere di almeno 8 caratteri.'); return
    }
    if (pwdForm.nuova !== pwdForm.conferma) {
      setPwdErr('Le password non coincidono.'); return
    }
    setPwdSaving(true)
    // Supabase Auth: aggiorna la password dell'utente loggato
    const { error } = await supabase.auth.updateUser({ password: pwdForm.nuova })
    setPwdSaving(false)
    if (error) {
      setPwdErr('Errore: ' + error.message); return
    }
    setPwdMsg('✅ Password aggiornata con successo!')
    setPwdForm({ attuale: '', nuova: '', conferma: '' })
    setTimeout(() => setPwdMsg(''), 4000)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, maxWidth:540 }}>
      {/* Notifiche */}
      {pushStatus !== 'unsupported' ? (
        <div className="card" style={{ 
          background: pushStatus === 'ok' ? 'var(--green-pale)' : 'var(--bg)',
          border: pushStatus === 'ok' ? '1.5px solid var(--green)' : '1.5px solid var(--border)'
        }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ fontSize:'1.5rem' }}>{pushStatus === 'ok' ? '🔔' : '🔕'}</div>
              <div>
                <div style={{ fontWeight:800, fontSize:'.95rem', color: pushStatus === 'ok' ? 'var(--green)' : 'var(--text)' }}>
                  {pushStatus === 'ok' ? 'Notifiche attive' : 'Notifiche disattivate'}
                </div>
                <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginTop:2 }}>
                  {pushStatus === 'ok' 
                    ? 'Riceverai avvisi su appello e buoni pasto.' 
                    : 'Attivale per non perdere gli avvisi importanti.'}
                </div>
              </div>
            </div>
            <button 
              className={`btn ${pushStatus === 'ok' ? 'btn-ghost' : 'btn-primary'} btn-sm`}
              onClick={abilitaNotifiche}
              disabled={pushStatus === 'loading'}
              style={{ minWidth: 100 }}
            >
              {pushStatus === 'loading' ? <span className="spinner" /> : pushStatus === 'ok' ? 'Aggiorna' : 'Attiva ora'}
            </button>
          </div>
          {pushStatus === 'denied' && (
            <div style={{ marginTop:12, fontSize:'.72rem', color:'var(--danger)', fontWeight:600 }}>
              ⚠️ Notifiche bloccate dal browser. Controlla i permessi nelle impostazioni del sito.
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ background: '#fff8e1', border: '1.5px solid #ffe082' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ fontSize:'1.5rem' }}>📲</div>
            <div style={{ fontSize:'.82rem', color: '#856404' }}>
              <b>Attenzione (iPhone):</b> Per ricevere le notifiche su iPhone, devi prima <b>aggiungere questa pagina alla schermata Home</b> (tasto Condividi <span style={{ fontSize: '1.2rem' }}>⎋</span> → "Aggiungi a Home").
            </div>
          </div>
        </div>
      )}

      {/* Dati personali */}
      <div className="card">
        <div className="card-title" style={{ marginBottom:18 }}>👤 Dati personali</div>
        {msg && <div className={`alert ${msg.startsWith('❌') ? 'alert-danger' : 'alert-success'}`}
          style={{ marginBottom:14 }}>{msg}</div>}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Nome *</label>
            <input className="form-input" value={form.nome} onChange={e => set('nome', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Cognome *</label>
            <input className="form-input" value={form.cognome} onChange={e => set('cognome', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Telefono</label>
          <input className="form-input" type="tel" value={form.telefono}
            onChange={e => set('telefono', e.target.value)} placeholder="3331234567" />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" value={authUser.email} disabled
            style={{ background:'var(--bg)', color:'var(--text-muted)' }} />
          <div className="form-hint">L'email non può essere modificata da qui.</div>
        </div>
        <button className="btn btn-primary" onClick={salvaProfilo} disabled={saving}>
          {saving ? <><span className="spinner" /> Salvataggio...</> : '💾 Salva modifiche'}
        </button>
      </div>

      {/* Cambio password */}
      <div className="card">
        <div className="card-title" style={{ marginBottom:18 }}>🔒 Cambia password</div>
        {pwdMsg && <div className="alert alert-success" style={{ marginBottom:14 }}>{pwdMsg}</div>}
        {pwdErr && <div className="alert alert-danger"  style={{ marginBottom:14 }}>{pwdErr}</div>}
        <div className="form-group">
          <label className="form-label">Nuova password *</label>
          <div style={{ position:'relative' }}>
            <input className="form-input" type={showPwd ? 'text' : 'password'}
              value={pwdForm.nuova} onChange={e => setPwd('nuova', e.target.value)}
              placeholder="Minimo 8 caratteri" style={{ paddingRight:48 }} />
            <button type="button" onClick={() => setShowPwd(s => !s)}
              style={{ position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',
                background:'none',border:'none',cursor:'pointer',fontSize:'1.1rem',
                color:'var(--text-muted)' }}>
              {showPwd ? '🙈' : '👁️'}
            </button>
          </div>
          {/* Indicatore robustezza password */}
          {pwdForm.nuova && (() => {
            const p = pwdForm.nuova
            let score = 0
            if (p.length >= 8)  score++
            if (p.length >= 12) score++
            if (/[A-Z]/.test(p)) score++
            if (/[0-9]/.test(p)) score++
            if (/[^a-zA-Z0-9]/.test(p)) score++
            const labels = ['', 'Molto debole','Debole','Discreta','Buona','Ottima']
            const colors = ['','#e74c3c','#e67e22','#f1c40f','#2ecc71','#27ae60']
            return (
              <div style={{ marginTop:6 }}>
                <div style={{ display:'flex', gap:3, marginBottom:3 }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex:1, height:4, borderRadius:2,
                      background: i <= score ? colors[score] : 'var(--border)',
                      transition:'background .2s',
                    }} />
                  ))}
                </div>
                <div style={{ fontSize:'.72rem', color:colors[score], fontWeight:700 }}>
                  {labels[score]}
                </div>
              </div>
            )
          })()}
        </div>
        <div className="form-group">
          <label className="form-label">Conferma nuova password *</label>
          <input className="form-input" type="password"
            value={pwdForm.conferma} onChange={e => setPwd('conferma', e.target.value)}
            placeholder="Ripeti la password" />
          {pwdForm.conferma && pwdForm.nuova !== pwdForm.conferma && (
            <div style={{ fontSize:'.78rem', color:'var(--danger)', marginTop:4 }}>
              ⚠️ Le password non coincidono
            </div>
          )}
          {pwdForm.conferma && pwdForm.nuova === pwdForm.conferma && pwdForm.nuova.length >= 8 && (
            <div style={{ fontSize:'.78rem', color:'var(--green)', marginTop:4 }}>
              ✅ Le password coincidono
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={cambiaPassword} disabled={pwdSaving}>
          {pwdSaving ? <><span className="spinner" /> Aggiornamento...</> : '🔒 Aggiorna password'}
        </button>
      </div>

      {/* Info account */}
      <div className="card" style={{ background:'var(--bg)', boxShadow:'none',
        border:'1.5px solid var(--border)' }}>
        <div style={{ fontSize:'.8rem', color:'var(--text-muted)', lineHeight:1.7 }}>
          <div><b>ID account:</b> <code style={{ fontSize:'.72rem' }}>{authUser.id?.slice(0,8)}...</code></div>
          <div><b>Email:</b> {authUser.email}</div>
          <div><b>Account creato:</b> {authUser.created_at
            ? new Date(authUser.created_at).toLocaleDateString('it', { day:'numeric', month:'long', year:'numeric' })
            : '—'}</div>
        </div>
      </div>
    </div>
  )
}


// Card iscrizione estesa — con buoni pasto e presenze
function IscrizioneCardEstesa({ i, goTo, dati }) {
  const ev = i.eventi || {}
  const [expanded, setExpanded] = useState(false)
  const buoni    = dati?.buoni   ?? null
  const appello  = dati?.appello || []
  const presenti = appello.filter(a => a.presenza === 'P').length
  const mensaCount = appello.filter(a => a.pranzo === 'mensa').length

  return (
    <div style={{
      background: '#fff', borderRadius: 14, marginBottom: 12,
      border: '1.5px solid var(--border)', overflow: 'hidden',
      boxShadow: 'var(--shadow)',
    }}>
      {/* Header */}
      <div style={{ padding:'14px 16px', borderBottom: expanded ? '1px solid var(--border-light)' : 'none' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:8 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:'.95rem', marginBottom:3 }}>
              🎪 {ev.nome || 'Evento'}
            </div>
            <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginBottom:4 }}>
              📅 {ev.data_inizio} → {ev.data_fine}
            </div>
            <div style={{ fontSize:'.85rem', fontWeight:600 }}>
              👦 {i.nome_bambino} {i.cognome_bambino}
            </div>
          </div>
          <div style={{ textAlign:'right', display:'flex', flexDirection:'column', gap:6, alignItems:'flex-end' }}>
            <div style={{ fontWeight:900, color:'var(--primary)', fontSize:'1.1rem' }}>
              €{Number(i.totale||0).toFixed(2)}
            </div>
            <span style={{
              background: i.saldato ? '#e8f5e9' : '#fff3e0',
              color: i.saldato ? '#2e7d32' : '#e65100',
              borderRadius:20, padding:'2px 10px', fontSize:'.72rem', fontWeight:700,
            }}>
              {i.saldato ? '✅ Saldato' : '⏳ Da saldare'}
            </span>
          </div>
        </div>

        {/* Mini stats sempre visibili */}
        <div style={{ display:'flex', gap:10, marginTop:10, flexWrap:'wrap', alignItems:'center' }}>
          {buoni !== null && (
            <div
              onClick={() => goTo && goTo('buoni', i.evento_id, { iscrizioneId: i.id })}
              style={{
                background: buoni <= 0 ? 'var(--danger-light)' : 'var(--secondary-pale)',
                borderRadius:8, padding:'4px 10px', fontSize:'.75rem', fontWeight:700,
                color: buoni <= 0 ? 'var(--danger)' : '#1a6b66',
                cursor: goTo ? 'pointer' : 'default',
                border: goTo ? '1.5px solid transparent' : 'none',
                transition: 'border .15s',
              }}
              title={goTo ? 'Clicca per acquistare buoni pasto' : ''}
            >
              🎟️ {buoni < 0 ? `⚠️ In debito: ${buoni} buoni` : buoni === 0 ? '⚠️ Buoni esauriti — clicca per ricaricare' : `${buoni} buoni pasto`}
            </div>
          )}
          {buoni === null && goTo && (
            <div
              onClick={() => goTo('buoni', i.evento_id, { iscrizioneId: i.id })}
              style={{
                background:'#fff8e1', borderRadius:8, padding:'4px 10px',
                fontSize:'.75rem', fontWeight:700, color:'#e65100',
                cursor:'pointer',
              }}>
              🎟️ Acquista buoni pasto
            </div>
          )}
          {appello.length > 0 && (
            <div style={{ background:'var(--green-pale)', borderRadius:8, padding:'4px 10px',
              fontSize:'.75rem', fontWeight:700, color:'#4a6c0f' }}>
              ✅ {presenti} presenze
            </div>
          )}
          {mensaCount > 0 && (
            <div style={{ background:'#fff8e1', borderRadius:8, padding:'4px 10px',
              fontSize:'.75rem', fontWeight:700, color:'#e65100' }}>
              🍽️ {mensaCount} pasti mensa
            </div>
          )}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop:8, fontSize:'.78rem' }}
          onClick={() => setExpanded(e => !e)}>
          {expanded ? '▲ Meno dettagli' : '▼ Vedi dettagli'}
        </button>
      </div>

      {/* Dettagli espandibili */}
      {expanded && (
        <div style={{ padding:'14px 16px' }}>
          {/* Appello recente */}
          {appello.length > 0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontWeight:700, fontSize:'.82rem', marginBottom:8, color:'var(--text-muted)' }}>
                Ultime presenze
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                {appello.slice(0,10).map(a => (
                  <div key={a.data} style={{
                    padding:'4px 9px', borderRadius:8, fontSize:'.72rem', fontWeight:700,
                    background: a.presenza === 'P' ? '#d1fae5' : '#fee2e2',
                    color: a.presenza === 'P' ? '#065f46' : '#991b1b',
                  }}>
                    {new Date(a.data + 'T12:00:00').toLocaleDateString('it', { day:'numeric', month:'short' })}
                    {a.pranzo === 'mensa' ? ' 🍽️' : a.pranzo === 'sacco' ? ' 🎒' : a.pranzo === 'casa' ? ' 🏠' : ''}
                  </div>
                ))}
                {appello.length > 10 && (
                  <div style={{ padding:'4px 9px', borderRadius:8, fontSize:'.72rem',
                    color:'var(--text-muted)', background:'var(--bg)' }}>
                    +{appello.length - 10} altri
                  </div>
                )}
              </div>
            </div>
          )}
          {/* Settimane iscritte */}
          {(i.settimane||[]).length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontWeight:700, fontSize:'.82rem', marginBottom:5, color:'var(--text-muted)' }}>
                Settimane iscritte
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {(i.settimane||[]).map(s => (
                  <span key={s} style={{ background:'var(--primary-pale)', color:'var(--primary)',
                    borderRadius:20, padding:'2px 10px', fontSize:'.76rem', fontWeight:700 }}>
                    Sett. {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Mensa settimane */}
          {(i.mensa_settimane||[]).length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight:700, fontSize:'.82rem', marginBottom:5, color:'var(--text-muted)' }}>
                Mensa prenotata per
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {(i.mensa_settimane||[]).map(s => (
                  <span key={s} style={{ background:'#fff8e1', color:'#e65100',
                    borderRadius:20, padding:'2px 10px', fontSize:'.76rem', fontWeight:700 }}>
                    🍽️ Sett. {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Bottone acquisto buoni */}
          {goTo && (
            <button
              className="btn btn-primary btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => goTo('buoni', i.evento_id, { iscrizioneId: i.id })}>
              🎟️ {buoni === 0 ? 'Ricarica buoni pasto' : buoni > 0 ? `Gestisci buoni (${buoni} rimasti)` : 'Acquista buoni pasto'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ADMIN CAMPETTO ───────────────────────────────────────────────────────────
const CONFIG_DEFAULT_CAMPETTO = {
  orario_inizio: 17,
  orario_fine: 22,
  prezzi: {
    '1h_no_docce': 10,
    '1h_docce': 15,
    '1_5h_no_docce': 14,
    '1_5h_docce': 19,
    'extra_h': 6,
    'extra_docce': 3
  },
  campi_extra: [],
  metodi_pagamento: ['Contanti','POS/Carta','Bonifico']
}

const CONFIG_DEFAULT_SALA = {
  prezzi: {
    'senza_riscaldamento': 80,
    'con_riscaldamento': 95,
    'aggiunta_campetto': 20
  },
  campi_extra: [],
  metodi_pagamento: ['Contanti','POS/Carta','Bonifico']
}

function AdminCampetto({ user, goPublic, goBack }) {
  const { data: prenotazioni, loading, reload } = useSupabaseData('prenotazioni_campetto', { order: 'created_at' })
  const [tab, setTab] = useState('prenotazioni')
  const [config, setConfig] = useState(null)
  const [editPrice, setEditPrice] = useState(false)
  const [editCampi, setEditCampi] = useState(false)
  const [prezzi, setPrezzi] = useState({})
  const [campiTemp, setCampiTemp] = useState({ _campi: [], _metodi: ['Contanti','POS/Carta','Bonifico'] })
  const [noteModal, setNoteModal] = useState(null)
  const canEdit = canManage(user.ruolo, 'campetto')

  useEffect(() => {
    const caricaConfig = async () => {
      const { data } = await supabase.from('configurazioni').select('valore').eq('id', 'campetto').single()
      if (data) {
        setConfig(data.valore)
        setPrezzi(data.valore.prezzi || CONFIG_DEFAULT_CAMPETTO.prezzi)
      } else {
        // Se non esiste, creiamo la configurazione di default
        await supabase.from('configurazioni').insert([{ id: 'campetto', valore: CONFIG_DEFAULT_CAMPETTO }])
        setConfig(CONFIG_DEFAULT_CAMPETTO)
        setPrezzi(CONFIG_DEFAULT_CAMPETTO.prezzi)
      }
    }
    caricaConfig()
  }, [])

  if (loading) return <LoadingPage text="Caricamento..." />

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => goPublic('campetto')}>🔗 Modulo pubblico</button>
        {canEdit && <button className="btn btn-ghost" onClick={() => setEditPrice(true)}>💰 Modifica prezzi</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => { setCampiTemp({ _campi: config?.campi_extra || [], _metodi: config?.metodi_pagamento || ['Contanti','POS/Carta','Bonifico'] }); setEditCampi(true) }}>➕ Campi form</button>}
      </div>
      <div className="tabs">
        {[['prenotazioni','📋 Prenotazioni'],['calendario','📅 Calendario']].map(([t,l]) => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
        ))}
      </div>
      {tab === 'prenotazioni' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Prenotazioni Campetto ({prenotazioni.length})</div>
            {prenotazioni.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => {
                const csv = ['Nome,Telefono,Data,Ora,Durata,Docce,Prezzo'].concat(prenotazioni.map(p => `${p.nome},${p.telefono},${p.data},${p.ora},${p.durata},${p.docce?'Sì':'No'},${p.prezzo}`)).join('\n')
                const a = document.createElement('a'); a.href = 'data:text/csv,' + encodeURIComponent(csv); a.download = 'campetto.csv'; a.click()
              }}>📥 CSV</button>
            )}
          </div>
          {prenotazioni.length === 0
            ? <div className="alert alert-info">Nessuna prenotazione.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Nome</th><th>Telefono</th><th>Data</th><th>Ora</th><th>Durata</th><th>Docce</th><th>Prezzo</th><th></th></tr></thead>
                <tbody>{prenotazioni.map(p => (
                  <tr key={p.id}>
                    <td><b>{p.nome}</b></td><td>{p.telefono}</td><td>{p.data}</td><td>{p.ora}</td><td>{p.durata}</td>
                    <td>{p.docce ? '✅' : '❌'}</td>
                    <td><b style={{ color: 'var(--accent)' }}>{fmt(p.prezzo)}</b></td>
                    <td>
                      {p.note_admin && (
                        <div style={{
                          fontSize: '.72rem', color: '#8e44ad', fontWeight: 600,
                          background: '#f3e8ff', borderRadius: 6, padding: '2px 7px',
                          marginBottom: 4, maxWidth: 160,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={p.note_admin}>
                          📝 {p.note_admin}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-ghost"
                          title={p.note_admin ? 'Modifica nota' : 'Aggiungi nota'}
                          onClick={() => setNoteModal({ tabella: 'prenotazioni_campetto', prenotazione: p })}
                          style={{ color: p.note_admin ? '#8e44ad' : undefined,
                            borderColor: p.note_admin ? '#8e44ad' : undefined }}>
                          📝
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('Eliminare?')) {
                          await supabase.from('prenotazioni_campetto').delete().eq('id', p.id)
                          logAudit({ user, azione: 'ELIMINA_PRENOTAZIONE_CAMPETTO', categoria: 'Prenotazioni',
                            dettaglio: `Eliminata prenotazione campetto di ${p.nome} per il ${p.data} alle ${p.ora}`,
                            meta: { id: p.id, nome: p.nome, data: p.data, ora: p.ora } })
                          reload() } }}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}
      {tab === 'calendario' && <Calendario prenotazioni={prenotazioni} />}
      {noteModal && <NoteModal tabella={noteModal.tabella} prenotazione={noteModal.prenotazione} user={user} onClose={() => { setNoteModal(null); reload() }} />}
      {editPrice && config && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditPrice(false)}>
          <div className="modal">
            <div className="modal-title">💰 Prezzi Campetto</div>
            {Object.entries(prezzi).map(([k, v]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{k.replace(/_/g, ' ')} (€)</label>
                <input className="form-input" type="number" value={v} onChange={e => setPrezzi(p => ({ ...p, [k]: +e.target.value }))} />
              </div>
            ))}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditPrice(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={async () => {
                const nuova = { ...config, prezzi }
                await supabase.from('configurazioni').update({ valore: nuova }).eq('id', 'campetto')
                setConfig(nuova); setEditPrice(false)
              }}>💾 Salva</button>
            </div>
          </div>
        </div>
      )}
      {editCampi && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditCampi(false)}>
          <div className="modal">
            <div className="modal-title">⚙️ Configura form — Campetto</div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>💳 Metodi di pagamento accettati</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
              {['Contanti','POS/Carta','Bonifico'].map(m => {
                const sel = (campiTemp._metodi || ['Contanti','POS/Carta','Bonifico']).includes(m)
                return (
                  <button key={m} type="button" className={`btn ${sel ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => {
                      const cur = campiTemp._metodi || ['Contanti','POS/Carta','Bonifico']
                      setCampiTemp(p => ({ ...p, _metodi: sel ? cur.filter(x => x !== m) : [...cur, m] }))
                    }}>
                    {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                  </button>
                )
              })}
            </div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>➕ Campi extra del form</div>
            <div className="alert alert-info" style={{ marginBottom: 12, fontSize: '.85rem' }}>
              I campi qui configurati appariranno nel modulo pubblico di prenotazione del campetto.
            </div>
            <EditorCampiExtra campi={campiTemp._campi || []}
              onChange={v => setCampiTemp(p => ({ ...p, _campi: v }))} />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditCampi(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={async () => {
                const nuova = { ...config, campi_extra: campiTemp._campi || [], metodi_pagamento: campiTemp._metodi || ['Contanti','POS/Carta','Bonifico'] }
                await supabase.from('configurazioni').update({ valore: nuova }).eq('id', 'campetto')
                setConfig(nuova); setEditCampi(false)
              }}>💾 Salva</button>
            </div>
          </div>
        </div>
      )}
      {noteModal && (
        <NoteModal
          tabella={noteModal.tabella}
          prenotazione={noteModal.prenotazione}
          user={user}
          onClose={() => { setNoteModal(null); reload() }}
        />
      )}
    </div>
  )
}


// ─── BANNER UTENTE LOGGATO (nei form pubblici) ───────────────────────────────
function BannerUtente({ authUser, profilo }) {
  if (!authUser) return null
  return (
    <div style={{
      background: 'linear-gradient(135deg, var(--secondary-pale), #e8f7f5)',
      border: '1.5px solid var(--secondary)',
      borderRadius: 12, padding: '10px 16px', marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--secondary), #16a085)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontWeight: 900, fontSize: '.9rem', flexShrink: 0,
      }}>
        {(profilo?.nome || authUser.email)?.[0]?.toUpperCase()}
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '.85rem', color: '#1a6b66' }}>
          ✅ Accesso effettuato — {profilo?.nome ? `${profilo.nome} ${profilo.cognome}` : authUser.email}
        </div>
        <div style={{ fontSize: '.75rem', color: '#2a9d8f' }}>
          I dati del tuo account sono pre-compilati automaticamente
        </div>
      </div>
    </div>
  )
}


// ─── GATE: richiede login per accedere ───────────────────────────────────────
// Mostra una schermata di blocco se l'utente non è loggato.
// onLogin / onRegistrati aprono le relative pagine.
function LoginGate({ authUser, titolo, icona, children, onLogin, onRegistrati }) {
  if (authUser) return children

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: '40px 20px',
    }}>
      <div style={{
        background: '#fff', borderRadius: 24, padding: '40px 32px',
        maxWidth: 420, width: '100%', textAlign: 'center',
        boxShadow: '0 8px 40px rgba(0,0,0,.1)',
        border: '1.5px solid var(--border)',
      }}>
        <div style={{ fontSize: '3rem', marginBottom: 12 }}>{icona || '🔒'}</div>
        <h2 style={{
          fontFamily: 'Nunito, sans-serif', fontWeight: 900,
          color: 'var(--primary)', marginBottom: 8, fontSize: '1.4rem',
        }}>
          Accedi per continuare
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 28, lineHeight: 1.6, fontSize: '.9rem' }}>
          Per {titolo || 'procedere'} è necessario accedere al tuo account
          o crearne uno gratuitamente.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
            onClick={onLogin}>
            🔓 Accedi
          </button>
          <button className="btn btn-ghost btn-lg" style={{
            width: '100%',
            background: 'var(--primary-pale)',
            color: 'var(--primary)',
            border: '1.5px solid var(--primary)',
          }} onClick={onRegistrati}>
            ✏️ Crea account gratuito
          </button>
        </div>
        <div style={{
          marginTop: 20, padding: '12px 16px',
          background: 'var(--bg)', borderRadius: 10,
          fontSize: '.78rem', color: 'var(--text-muted)', lineHeight: 1.6,
        }}>
          💡 La registrazione è gratuita e ti permette di gestire tutte
          le tue prenotazioni e iscrizioni in un unico posto.
        </div>
      </div>
    </div>
  )
}

// ─── PUBLIC: CAMPETTO ─────────────────────────────────────────────────────────
// ─── COMPONENTE PULSANTE ATTIVA NOTIFICHE ────────────────────────────────────
function PushAttivaBtn({ externalId, label = '' }) {
  const [status, setStatus] = useState('idle') // 'idle'|'loading'|'ok'|'denied'

  const attiva = async () => {
    setStatus('loading')
    try {
      initOneSignal()
      const sub = await subscribeOneSignal(externalId)
      setStatus(sub ? 'ok' : 'denied')
    } catch { setStatus('denied') }
  }

  if (status === 'ok') return (
    <div className="alert alert-success" style={{ marginTop: 16, textAlign: 'left' }}>
      🔔 Notifiche attivate! Riceverai aggiornamenti su questo dispositivo.
    </div>
  )
  if (status === 'denied') return (
    <div className="alert alert-danger" style={{ marginTop: 16, textAlign: 'left' }}>
      🔕 Il browser ha negato le notifiche. Puoi attivarle dal lucchetto 🔒 nella barra dell'indirizzo.
    </div>
  )
  return (
    <div style={{ marginTop: 20, padding: '16px 20px', background: 'var(--primary-pale)', borderRadius: 12, border: '1.5px solid var(--border)', textAlign: 'left' }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--primary)' }}>🔔 Vuoi ricevere notifiche?</div>
      <div style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>
        Attiva le notifiche push per ricevere aggiornamenti sulla tua prenotazione direttamente su questo dispositivo.
      </div>
      <button
        className="btn btn-primary"
        onClick={attiva}
        disabled={status === 'loading'}>
        {status === 'loading'
          ? <><span className="spinner" /> Attivazione...</>
          : '🔔 Attiva notifiche push'}
      </button>
    </div>
  )
}

function PubCampettoForm({ onBack, authUser, profilo }) {
  const [config, setConfig] = useState(null)
  const [form, setForm] = useState({ nome: '', telefono: '', email: '', data: '', ora: '17:00', durata: '1h', docce: false, note: '', dati_extra: {}, metodo_pagamento: '', consenso_privacy: false })
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const { dateBloccate, isBloccata } = useDateBloccate()
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setExtra = (id, val) => setForm(p => ({ ...p, dati_extra: { ...p.dati_extra, [id]: val } }))

  useEffect(() => {
    const caricaConfig = async () => {
      const { data } = await supabase.from('configurazioni').select('valore').eq('id', 'campetto').single()
      if (data) {
        setConfig(data.valore)
      } else {
        // Se non esiste, creiamo la configurazione di default
        await supabase.from('configurazioni').insert([{ id: 'campetto', valore: CONFIG_DEFAULT_CAMPETTO }])
        setConfig(CONFIG_DEFAULT_CAMPETTO)
      }
    }
    caricaConfig()
    // Pre-compila con dati account se loggato
    if (authUser && profilo) {
      setForm(p => ({
        ...p,
        nome: `${profilo.nome || ''} ${profilo.cognome || ''}`.trim(),
        email: authUser.email || '',
        telefono: profilo.telefono || '',
      }))
    }
  }, [authUser, profilo]) // eslint-disable-line

  if (!config) return <div className="public-page"><LoadingPage text="Caricamento..." /></div>

  const p = config.prezzi
  const calcPrezzo = () => {
    const { durata, docce } = form
    if (durata === '1h')   return docce ? p['1h_docce']   : p['1h_no_docce']
    if (durata === '1.5h') return docce ? p['1_5h_docce'] : p['1_5h_no_docce']
    return (+durata.replace('h', '') * p.extra_h) + (docce ? p.extra_docce : 0)
  }

  const invia = async () => {
    setSaving(true)
    // Anti-sovrapposizione: stessa data + orario sovrapposto
    const { data: esistentiCamp } = await supabase
      .from('prenotazioni_campetto').select('ora, durata').eq('data', form.data)
    if (esistentiCamp && esistentiCamp.length > 0) {
      const durMin = { '1h':60,'1.5h':90,'2h':120,'2.5h':150,'3h':180 }
      const toMs = (t) => { const [h,m] = t.split(':').map(Number); return h*60+m }
      const ns = toMs(form.ora); const ne = ns + (durMin[form.durata]||60)
      const conflitto = esistentiCamp.some(p => {
        const ps = toMs(p.ora||'00:00'); const pe = ps + (durMin[p.durata]||60)
        return ns < pe && ne > ps
      })
      if (conflitto) {
        alert('⚠️ Il campetto è già prenotato in questo orario. Scegli un orario diverso.')
        setSaving(false); return
      }
    }
    const { error: errCamp } = await supabase.from('prenotazioni_campetto').insert([{
      ...form, prezzo: calcPrezzo(),
      utente_id: authUser?.id || null,
    }])
    if (errCamp) { alert('Errore: ' + errCamp.message); setSaving(false); return }
    logAudit({ user: { nome: form.nome, email: form.email || '', id: null },
      azione: 'NUOVA_PRENOTAZIONE_CAMPETTO', categoria: 'Prenotazioni',
      dettaglio: `${form.nome} ha prenotato il campetto per il ${form.data} alle ${form.ora} (${form.durata})`,
      meta: { nome: form.nome, data: form.data, ora: form.ora, durata: form.durata } })
    sendPushNotification({
      titolo: '⚽ Nuova prenotazione campetto',
      corpo:  `${form.nome} ha prenotato il campetto per il ${form.data} alle ${form.ora}`,
      target_tipo: 'superadmin',
    })
    setSaving(false); setSuccess(true)
  }

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>⚽</div>
      <h2 style={{ color: 'var(--primary)' }}>Prenotazione inviata!</h2>
      <div className="price-box" style={{ maxWidth: 300, margin: '20px auto' }}>
        <div className="price-total">{fmt(calcPrezzo())}</div>
        <div className="price-breakdown">Totale da versare</div>
      </div>
      {form.email && <PushAttivaBtn externalId={`prenotante_${form.email.replace(/[^a-z0-9]/gi,'_')}`} />}
      <div style={{ marginTop: 20, display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        <button className="btn btn-primary btn-lg" onClick={() => { setSuccess(false); setForm({ nome: '', telefono: '', email: '', data: '', ora: '17:00', durata: '1h', docce: false, note: '' }) }}>+ Nuova prenotazione</button>
        {authUser && <button className="btn btn-success btn-lg" onClick={() => { /* goTo handled by onBack + view */ onBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('goto-area-personale')), 100) }}>👤 La mia area →</button>}
        <button className="btn btn-ghost btn-lg" onClick={onBack}>← Home</button>
      </div>
    </div></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>⚽</div>
        <h1>Prenota il Campetto</h1>
        <p>Oratorio di Sergnano · Disponibile {config.orario_inizio}:00 – {config.orario_fine}:00</p>
      </div>
      <div className="card">
        <BannerUtente authUser={authUser} profilo={profilo} />
        <div className="form-group"><label className="form-label">Nome e cognome *</label><input className="form-input" value={form.nome} onChange={e => set('nome', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Telefono *</label><input className="form-input" type="tel" value={form.telefono} onChange={e => set('telefono', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Email</label><input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Data *</label><input className="form-input" type="date" value={form.data} onChange={e => set('data', e.target.value)} min={today()} /></div>
          <div className="form-group"><label className="form-label">Ora inizio</label>
            <select className="form-select" value={form.ora} onChange={e => set('ora', e.target.value)}>
              {['17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30','21:00'].map(o => <option key={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Durata *</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['1h','1.5h','2h','2.5h','3h'].map(d => (
              <button key={d} className={`btn ${form.durata === d ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set('durata', d)}>{d}</button>
            ))}
          </div>
        </div>
        <label className={`check-item ${form.docce ? 'checked' : ''}`} style={{ marginBottom: 20 }}>
          <input type="checkbox" checked={form.docce} onChange={e => set('docce', e.target.checked)} />
          <span>🚿 Includi docce (+{fmt(p.extra_docce)})</span>
        </label>
        <div className="price-box" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Totale</div>
          <div className="price-total">{fmt(calcPrezzo())}</div>
        </div>
        <div className="form-group"><label className="form-label">Note</label><textarea className="form-textarea" value={form.note} onChange={e => set('note', e.target.value)} /></div>
        {(config.campi_extra || []).length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>Informazioni aggiuntive</div>
            {(config.campi_extra || []).map(campo => (
              <CampoExtra key={campo.id} campo={campo} value={form.dati_extra[campo.id]} onChange={val => setExtra(campo.id, val)} />
            ))}
          </div>
        )}
        {(config.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).length > 0 && (
          <div className="form-group">
            <label className="form-label">Metodo di pagamento *</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(config.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).map(m => (
                <button key={m} type="button" className={`btn ${form.metodo_pagamento === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set('metodo_pagamento', m)}>
                  {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* GDPR */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
          <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`} style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.consenso_privacy}
              onChange={e => set('consenso_privacy', e.target.checked)} />
            <span style={{ fontSize: '.85rem' }}>
              Acconsento al trattamento dei dati personali ai sensi del GDPR (Reg. UE 2016/679) *
            </span>
          </label>
        </div>
        {form.data && isBloccata(form.data) && (
          <div className="alert alert-warn" style={{ marginBottom: 12 }}>
            🚫 Il campetto non è disponibile in questa data.
            {dateBloccate.find && (() => {
              const trovata = dateBloccate
              return null
            })()}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-ghost" onClick={onBack}>← Indietro</button>
          <button className="btn btn-primary btn-lg" onClick={invia}
            disabled={saving || !form.nome || !form.data || !form.telefono || !form.consenso_privacy || (form.data && isBloccata(form.data))}
            style={{ flex: 1 }}>
            {saving ? <><span className="spinner" /> Invio...</> : '📩 Prenota'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── ADMIN SALA ───────────────────────────────────────────────────────────────
function AdminSala({ user, goPublic, goBack }) {
  const { data: prenotazioni, loading, reload } = useSupabaseData('prenotazioni_sala', { order: 'created_at' })
  const [tab, setTab] = useState('prenotazioni')
  const [config, setConfig] = useState(null)
  const [editPrice, setEditPrice] = useState(false)
  const [editCampi, setEditCampi] = useState(false)
  const [prezzi, setPrezzi] = useState({})
  const [campiTemp, setCampiTemp] = useState({ _campi: [], _metodi: ['Contanti','POS/Carta','Bonifico'] })
  const [noteModal, setNoteModal] = useState(null)
  const canEdit = canManage(user.ruolo, 'sala')

  useEffect(() => {
    const caricaConfig = async () => {
      const { data } = await supabase.from('configurazioni').select('valore').eq('id', 'sala').single()
      if (data) {
        setConfig(data.valore)
        setPrezzi(data.valore.prezzi || CONFIG_DEFAULT_SALA.prezzi)
      } else {
        // Se non esiste, creiamo la configurazione di default
        await supabase.from('configurazioni').insert([{ id: 'sala', valore: CONFIG_DEFAULT_SALA }])
        setConfig(CONFIG_DEFAULT_SALA)
        setPrezzi(CONFIG_DEFAULT_SALA.prezzi)
      }
    }
    caricaConfig()
  }, [])

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => goPublic('sala')}>🔗 Modulo pubblico</button>
        {canEdit && <button className="btn btn-ghost" onClick={() => setEditPrice(true)}>💰 Modifica prezzi</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => { setCampiTemp({ _campi: config?.campi_extra || [], _metodi: config?.metodi_pagamento || ['Contanti','POS/Carta','Bonifico'] }); setEditCampi(true) }}>➕ Campi form</button>}
      </div>
      <div className="tabs">
        {[['prenotazioni','📋 Prenotazioni'],['calendario','📅 Calendario']].map(([t,l]) => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
        ))}
      </div>
      {tab === 'prenotazioni' && (
        <div className="card">
          <div className="card-header"><div className="card-title">Prenotazioni Sala Feste ({prenotazioni.length})</div></div>
          {prenotazioni.length === 0
            ? <div className="alert alert-info">Nessuna prenotazione.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Nome</th><th>Data</th><th>Riscald.</th><th>Campetto</th><th>Persone</th><th>Prezzo</th><th></th></tr></thead>
                <tbody>{prenotazioni.map(p => (
                  <tr key={p.id}>
                    <td><b>{p.nome}</b></td><td>{p.data}</td>
                    <td>{p.riscaldamento ? '✅' : '❌'}</td><td>{p.campetto ? '✅' : '❌'}</td>
                    <td>{p.persone}</td>
                    <td><b style={{ color: 'var(--accent)' }}>{fmt(p.prezzo)}</b></td>
                    <td>
                      {p.note_admin && (
                        <div style={{
                          fontSize: '.72rem', color: '#8e44ad', fontWeight: 600,
                          background: '#f3e8ff', borderRadius: 6, padding: '2px 7px',
                          marginBottom: 4, maxWidth: 160,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={p.note_admin}>
                          📝 {p.note_admin}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-ghost"
                          title={p.note_admin ? 'Modifica nota' : 'Aggiungi nota'}
                          onClick={() => setNoteModal({ tabella: 'prenotazioni_sala', prenotazione: p })}
                          style={{ color: p.note_admin ? '#8e44ad' : undefined,
                            borderColor: p.note_admin ? '#8e44ad' : undefined }}>
                          📝
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('Eliminare?')) {
                          await supabase.from('prenotazioni_sala').delete().eq('id', p.id)
                          logAudit({ user, azione: 'ELIMINA_PRENOTAZIONE_SALA', categoria: 'Prenotazioni',
                            dettaglio: `Eliminata prenotazione sala di ${p.nome} per il ${p.data}`,
                            meta: { id: p.id, nome: p.nome, data: p.data } })
                          reload() } }}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}
      {tab === 'calendario' && <Calendario prenotazioni={prenotazioni} />}
      {noteModal && <NoteModal tabella={noteModal.tabella} prenotazione={noteModal.prenotazione} user={user} onClose={() => { setNoteModal(null); reload() }} />}
      {editPrice && config && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditPrice(false)}>
          <div className="modal">
            <div className="modal-title">💰 Prezzi Sala Feste</div>
            {Object.entries(prezzi).map(([k, v]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{k.replace(/_/g, ' ')} (€)</label>
                <input className="form-input" type="number" value={v} onChange={e => setPrezzi(p => ({ ...p, [k]: +e.target.value }))} />
              </div>
            ))}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditPrice(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={async () => {
                const nuova = { ...config, prezzi }
                await supabase.from('configurazioni').update({ valore: nuova }).eq('id', 'sala')
                setConfig(nuova); setEditPrice(false)
              }}>💾 Salva</button>
            </div>
          </div>
        </div>
      )}
      {editCampi && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditCampi(false)}>
          <div className="modal">
            <div className="modal-title">⚙️ Configura form — Sala Feste</div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>💳 Metodi di pagamento accettati</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
              {['Contanti','POS/Carta','Bonifico'].map(m => {
                const sel = (campiTemp._metodi || ['Contanti','POS/Carta','Bonifico']).includes(m)
                return (
                  <button key={m} type="button" className={`btn ${sel ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => {
                      const cur = campiTemp._metodi || ['Contanti','POS/Carta','Bonifico']
                      setCampiTemp(p => ({ ...p, _metodi: sel ? cur.filter(x => x !== m) : [...cur, m] }))
                    }}>
                    {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                  </button>
                )
              })}
            </div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>➕ Campi extra del form</div>
            <EditorCampiExtra campi={campiTemp._campi || []}
              onChange={v => setCampiTemp(p => ({ ...p, _campi: v }))} />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditCampi(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={async () => {
                const nuova = { ...config, campi_extra: campiTemp._campi || [], metodi_pagamento: campiTemp._metodi || ['Contanti','POS/Carta','Bonifico'] }
                await supabase.from('configurazioni').update({ valore: nuova }).eq('id', 'sala')
                setConfig(nuova); setEditCampi(false)
              }}>💾 Salva</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── PUBLIC: SALA ─────────────────────────────────────────────────────────────
function PubSalaForm({ onBack, authUser, profilo }) {
  const [config, setConfig] = useState(null)
  const [form, setForm] = useState({ nome: '', telefono: '', email: '', data: '', riscaldamento: false, campetto: false, persone: '', note: '', dati_extra: {}, metodo_pagamento: '', consenso_privacy: false })
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const { isBloccata } = useDateBloccate()
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setExtra = (id, val) => setForm(p => ({ ...p, dati_extra: { ...p.dati_extra, [id]: val } }))

  useEffect(() => {
    const caricaConfig = async () => {
      const { data } = await supabase.from('configurazioni').select('valore').eq('id', 'sala').single()
      if (data) {
        setConfig(data.valore)
      } else {
        // Se non esiste, creiamo la configurazione di default
        await supabase.from('configurazioni').insert([{ id: 'sala', valore: CONFIG_DEFAULT_SALA }])
        setConfig(CONFIG_DEFAULT_SALA)
      }
    }
    caricaConfig()
    if (authUser && profilo) {
      setForm(p => ({
        ...p,
        nome: `${profilo.nome || ''} ${profilo.cognome || ''}`.trim(),
        email: authUser.email || '',
        telefono: profilo.telefono || '',
      }))
    }
  }, [authUser, profilo]) // eslint-disable-line

  if (!config) return <div className="public-page"><LoadingPage /></div>
  const p = config.prezzi
  const calcPrezzo = () => (form.riscaldamento ? p.con_riscaldamento : p.senza_riscaldamento) + (form.campetto ? p.aggiunta_campetto : 0)

  const invia = async () => {
    setSaving(true)
    // Anti-sovrapposizione: 1 sola prenotazione al giorno
    const { data: esistentiSala } = await supabase
      .from('prenotazioni_sala').select('id').eq('data', form.data)
    if (esistentiSala && esistentiSala.length > 0) {
      alert('⚠️ La sala feste è già prenotata per questo giorno. Scegli un altra data.')
      setSaving(false); return
    }
    const { error: errSala } = await supabase.from('prenotazioni_sala').insert([{
      ...form, prezzo: calcPrezzo(),
      utente_id: authUser?.id || null,
    }])
    if (errSala) { alert('Errore: ' + errSala.message); setSaving(false); return }
    logAudit({ user: { nome: form.nome, email: form.email || '', id: null },
      azione: 'NUOVA_PRENOTAZIONE_SALA', categoria: 'Prenotazioni',
      dettaglio: `${form.nome} ha prenotato la sala per il ${form.data}`,
      meta: { nome: form.nome, data: form.data, persone: form.persone } })
    sendPushNotification({
      titolo: '🎉 Nuova prenotazione sala feste',
      corpo:  `${form.nome} ha prenotato la sala per il ${form.data}`,
      target_tipo: 'superadmin',
    })
    setSaving(false); setSuccess(true)
  }

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>🎉</div>
      <h2 style={{ color: 'var(--primary)' }}>Prenotazione inviata!</h2>
      <div className="price-box" style={{ maxWidth: 300, margin: '20px auto' }}>
        <div className="price-total">{fmt(calcPrezzo())}</div>
        <div className="price-breakdown">Totale da versare</div>
      </div>
      {form.email && <PushAttivaBtn externalId={`prenotante_${form.email.replace(/[^a-z0-9]/gi,'_')}`} />}
      <div style={{ marginTop: 20, display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        <button className="btn btn-primary btn-lg" onClick={() => { setSuccess(false); setForm({ nome: '', telefono: '', email: '', data: '', riscaldamento: false, campetto: false, persone: '', note: '' }) }}>+ Nuova prenotazione</button>
        {authUser && <button className="btn btn-success btn-lg" onClick={() => { onBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('goto-area-personale')), 100) }}>👤 La mia area →</button>}
        <button className="btn btn-ghost btn-lg" onClick={onBack}>← Home</button>
      </div>
    </div></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header"><div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🎉</div><h1>Prenota la Sala Feste</h1><p>Oratorio di Sergnano</p></div>
      <div className="card">
        <BannerUtente authUser={authUser} profilo={profilo} />
        <div className="form-group"><label className="form-label">Nome e cognome *</label><input className="form-input" value={form.nome} onChange={e => set('nome', e.target.value)} /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Telefono *</label><input className="form-input" type="tel" value={form.telefono} onChange={e => set('telefono', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Email</label><input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Data *</label><input className="form-input" type="date" value={form.data} onChange={e => set('data', e.target.value)} min={today()} /></div>
          <div className="form-group"><label className="form-label">Numero partecipanti</label><input className="form-input" type="number" value={form.persone} onChange={e => set('persone', e.target.value)} /></div>
        </div>
        <div className="check-group" style={{ marginBottom: 20 }}>
          <label className={`check-item ${form.riscaldamento ? 'checked' : ''}`}>
            <input type="checkbox" checked={form.riscaldamento} onChange={e => set('riscaldamento', e.target.checked)} />
            <span>🔥 Riscaldamento (+{fmt(p.con_riscaldamento - p.senza_riscaldamento)})</span>
          </label>
          <label className={`check-item ${form.campetto ? 'checked' : ''}`}>
            <input type="checkbox" checked={form.campetto} onChange={e => set('campetto', e.target.checked)} />
            <span>⚽ Aggiungi campetto (+{fmt(p.aggiunta_campetto)})</span>
          </label>
        </div>
        <div className="price-box" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Totale</div>
          <div className="price-total">{fmt(calcPrezzo())}</div>
        </div>
        <div className="form-group"><label className="form-label">Note</label><textarea className="form-textarea" value={form.note} onChange={e => set('note', e.target.value)} /></div>
        {(config.campi_extra || []).length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>Informazioni aggiuntive</div>
            {(config.campi_extra || []).map(campo => (
              <CampoExtra key={campo.id} campo={campo} value={form.dati_extra[campo.id]} onChange={val => setExtra(campo.id, val)} />
            ))}
          </div>
        )}
        {(config.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).length > 0 && (
          <div className="form-group">
            <label className="form-label">Metodo di pagamento *</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(config.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']).map(m => (
                <button key={m} type="button" className={`btn ${form.metodo_pagamento === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set('metodo_pagamento', m)}>
                  {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
          <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`} style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.consenso_privacy}
              onChange={e => set('consenso_privacy', e.target.checked)} />
            <span style={{ fontSize: '.85rem' }}>
              Acconsento al trattamento dei dati personali ai sensi del GDPR (Reg. UE 2016/679) *
            </span>
          </label>
        </div>
        {form.data && isBloccata(form.data) && (
          <div className="alert alert-warn" style={{ marginBottom: 12 }}>
            🚫 La sala feste non è disponibile in questa data.
          </div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-ghost" onClick={onBack}>← Indietro</button>
          <button className="btn btn-primary btn-lg" onClick={invia}
            disabled={saving || !form.nome || !form.data || !form.consenso_privacy || (form.data && isBloccata(form.data))}
            style={{ flex: 1 }}>
            {saving ? <><span className="spinner" /> Invio...</> : '📩 Prenota'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── ADMIN APPARTAMENTO ───────────────────────────────────────────────────────
function AdminAppartamento({ user, goPublic, goBack }) {
  const { data: prenotazioni, loading, reload } = useSupabaseData('prenotazioni_appartamento', { order: 'created_at' })
  const [tab, setTab] = useState('prenotazioni')
  const [campiExtra, setCampiExtra] = useState([])
  const [editCampi, setEditCampi] = useState(false)
  const [campiTemp, setCampiTemp] = useState([])
  const [noteModal, setNoteModal] = useState(null)
  const canEdit = canManage(user.ruolo, 'appartamento')

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'appartamento').single()
      .then(({ data }) => { if (data?.valore?.campi_extra) setCampiExtra(data.valore.campi_extra) })
  }, [])

  if (loading) return <LoadingPage />

  const salvaCampi = async () => {
    await supabase.from('configurazioni').upsert({ id: 'appartamento', valore: { campi_extra: campiTemp } })
    setCampiExtra(campiTemp); setEditCampi(false)
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => goPublic('appartamento')}>🔗 Modulo pubblico</button>
        {canEdit && <button className="btn btn-ghost" onClick={() => { setCampiTemp(campiExtra); setEditCampi(true) }}>➕ Campi form</button>}
      </div>
      <div className="tabs">
        {[['prenotazioni','📋 Prenotazioni'],['calendario','📅 Calendario']].map(([t,l]) => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
        ))}
      </div>
      {tab === 'prenotazioni' && (
        <div className="card">
          <div className="card-header"><div className="card-title">Prenotazioni Appartamento ({prenotazioni.length})</div></div>
          {prenotazioni.length === 0
            ? <div className="alert alert-info">Nessuna prenotazione.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Gruppo</th><th>Referente</th><th>Email</th><th>Arrivo</th><th>Partenza</th><th>Part.</th><th></th></tr></thead>
                <tbody>{prenotazioni.map(p => (
                  <tr key={p.id}>
                    <td><b>{p.nome_gruppo}</b></td><td>{p.referente}</td><td>{p.email}</td>
                    <td>{p.arrivo}</td><td>{p.partenza}</td><td>{p.partecipanti}</td>
                    <td>
                      {p.note_admin && (
                        <div style={{
                          fontSize: '.72rem', color: '#8e44ad', fontWeight: 600,
                          background: '#f3e8ff', borderRadius: 6, padding: '2px 7px',
                          marginBottom: 4, maxWidth: 160,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={p.note_admin}>
                          📝 {p.note_admin}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-ghost"
                          title={p.note_admin ? 'Modifica nota' : 'Aggiungi nota'}
                          onClick={() => setNoteModal({ tabella: 'prenotazioni_appartamento', prenotazione: p })}
                          style={{ color: p.note_admin ? '#8e44ad' : undefined,
                            borderColor: p.note_admin ? '#8e44ad' : undefined }}>
                          📝
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('Eliminare?')) {
                          await supabase.from('prenotazioni_appartamento').delete().eq('id', p.id)
                          logAudit({ user, azione: 'ELIMINA_PRENOTAZIONE_APPARTAMENTO', categoria: 'Prenotazioni',
                            dettaglio: `Eliminata prenotazione appartamento di ${p.referente} (${p.nome_gruppo}) dal ${p.arrivo} al ${p.partenza}`,
                            meta: { id: p.id, referente: p.referente, arrivo: p.arrivo, partenza: p.partenza } })
                          reload() } }}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}
      {tab === 'calendario' && <Calendario prenotazioni={prenotazioni.map(p => ({ ...p, data: p.arrivo }))} />}
      {noteModal && <NoteModal tabella={noteModal.tabella} prenotazione={noteModal.prenotazione} user={user} onClose={() => { setNoteModal(null); reload() }} />}
      {editCampi && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditCampi(false)}>
          <div className="modal">
            <div className="modal-title">➕ Campi extra — Modulo Appartamento</div>
            <div className="alert alert-info" style={{ marginBottom: 16 }}>
              I campi qui configurati appariranno nel modulo pubblico di richiesta appartamento.
            </div>
            <EditorCampiExtra campi={campiTemp} onChange={setCampiTemp} />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditCampi(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={salvaCampi}>💾 Salva</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── PUBLIC: APPARTAMENTO ─────────────────────────────────────────────────────
function PubAppartamentoForm({ onBack, authUser, profilo }) {
  const [campiExtra, setCampiExtra] = useState([])
  const [imgPortfolio, setImgPortfolio] = useState(null)
  const [form, setForm] = useState({ nome_gruppo: '', referente: '', email: '', telefono: '', arrivo: '', partenza: '', partecipanti: '', note: '', dati_extra: {}, consenso_privacy: false })
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setExtra = (id, val) => setForm(p => ({ ...p, dati_extra: { ...p.dati_extra, [id]: val } }))

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'appartamento').single()
      .then(({ data }) => { if (data?.valore?.campi_extra) setCampiExtra(data.valore.campi_extra) })
    
    // Carica immagine portfolio se disponibile
    supabase.from('configurazioni').select('valore').eq('id', 'portfolio_spazi').maybeSingle()
      .then(({ data }) => {
        const spazio = data?.valore?.spazi?.find(s => s.collegamento_form === 'appartamento')
        if (spazio?.foto) setImgPortfolio(spazio.foto)
      })

    if (authUser && profilo) {
      setForm(p => ({
        ...p,
        referente: `${profilo.nome || ''} ${profilo.cognome || ''}`.trim(),
        email: authUser.email || '',
        telefono: profilo.telefono || '',
      }))
    }
  }, [authUser, profilo]) // eslint-disable-line

  const invia = async () => {
    setSaving(true)
    // Anti-sovrapposizione date appartamento
    const { data: esistentiApp } = await supabase
      .from('prenotazioni_appartamento').select('arrivo, partenza')
    if (esistentiApp && esistentiApp.length > 0) {
      const na = new Date(form.arrivo); const np = new Date(form.partenza)
      const conflitto = esistentiApp.some(p =>
        na <= new Date(p.partenza) && np >= new Date(p.arrivo))
      if (conflitto) {
        alert('⚠️appartamento è già occupato in queste date. Scegli date diverse.')
        setSaving(false); return
      }
    }
    const { error: errApp } = await supabase.from('prenotazioni_appartamento').insert([{
      ...form, utente_id: authUser?.id || null,
    }])
    if (errApp) { alert('Errore: ' + errApp.message); setSaving(false); return }
    logAudit({ user: { nome: form.referente, email: form.email || '', id: null },
      azione: 'NUOVA_PRENOTAZIONE_APPARTAMENTO', categoria: 'Prenotazioni',
      dettaglio: `${form.referente} (${form.nome_gruppo}) ha richiesto l'appartamento dal ${form.arrivo} al ${form.partenza}`,
      meta: { referente: form.referente, gruppo: form.nome_gruppo, arrivo: form.arrivo, partenza: form.partenza } })
    sendPushNotification({
      titolo: '🏡 Nuova richiesta appartamento',
      corpo:  `${form.referente} (${form.nome_gruppo}) ha richiesto l'appartamento dal ${form.arrivo} al ${form.partenza}`,
      target_tipo: 'superadmin',
    })
    setSaving(false); setSuccess(true)
  }

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>🏡</div>
      <h2 style={{ color: 'var(--primary)' }}>Richiesta inviata!</h2>
      <p style={{ color: 'var(--text-muted)', margin: '12px 0 24px' }}>Vi contatteremo presto per confermare la disponibilità.</p>
      {form.email && <PushAttivaBtn externalId={`prenotante_${form.email.replace(/[^a-z0-9]/gi,'_')}`} />}
      <div style={{ marginTop: 20, display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        <button className="btn btn-primary btn-lg" onClick={() => { setSuccess(false); setForm({ nome_gruppo: '', referente: '', email: '', telefono: '', arrivo: '', partenza: '', partecipanti: '', note: '' }) }}>+ Nuova richiesta</button>
        {authUser && <button className="btn btn-success btn-lg" onClick={() => { onBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('goto-area-personale')), 100) }}>👤 La mia area →</button>}
        <button className="btn btn-ghost btn-lg" onClick={onBack}>← Home</button>
      </div>
    </div></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header"><div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🏡</div><h1>Prenota l'Appartamento</h1><p>Oratorio di Sergnano</p></div>
      <div className="card">
        {imgPortfolio && <img src={imgPortfolio} alt="Appartamento" style={{ width: '100%', height: 200, objectFit: 'cover', borderRadius: 12, marginBottom: 16 }} />}
        <BannerUtente authUser={authUser} profilo={profilo} />
        <div className="form-row">
          <div className="form-group"><label className="form-label">Nome gruppo / associazione *</label><input className="form-input" value={form.nome_gruppo} onChange={e => set('nome_gruppo', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Referente *</label><input className="form-input" value={form.referente} onChange={e => set('referente', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Email *</label><input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Telefono</label><input className="form-input" type="tel" value={form.telefono} onChange={e => set('telefono', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Data arrivo *</label><input className="form-input" type="date" value={form.arrivo} onChange={e => set('arrivo', e.target.value)} min={today()} /></div>
          <div className="form-group"><label className="form-label">Data partenza *</label><input className="form-input" type="date" value={form.partenza} onChange={e => set('partenza', e.target.value)} min={form.arrivo || today()} /></div>
        </div>
        <div className="form-group"><label className="form-label">Numero partecipanti</label><input className="form-input" type="number" value={form.partecipanti} onChange={e => set('partecipanti', e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Note o richieste particolari</label><textarea className="form-textarea" value={form.note} onChange={e => set('note', e.target.value)} /></div>
        {campiExtra.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>Informazioni aggiuntive</div>
            {campiExtra.map(campo => (
              <CampoExtra key={campo.id} campo={campo} value={form.dati_extra[campo.id]} onChange={val => setExtra(campo.id, val)} />
            ))}
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
          <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`} style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.consenso_privacy}
              onChange={e => set('consenso_privacy', e.target.checked)} />
            <span style={{ fontSize: '.85rem' }}>
              Acconsento al trattamento dei dati personali ai sensi del GDPR (Reg. UE 2016/679) *
            </span>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-ghost" onClick={onBack}>← Indietro</button>
          <button className="btn btn-primary btn-lg" onClick={invia} disabled={saving || !form.nome_gruppo || !form.arrivo || !form.email || !form.consenso_privacy} style={{ flex: 1 }}>
            {saving ? <><span className="spinner" /> Invio...</> : '📩 Invia richiesta'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── ADMIN AULE ───────────────────────────────────────────────────────────────
function AdminAule({ user, goPublic, goBack }) {
  const { data: prenotazioni, loading, reload } = useSupabaseData('prenotazioni_aule', { order: 'created_at' })
  const [tab, setTab]           = useState('prenotazioni')
  const [config, setConfig]     = useState({ aule: [], campi_extra: [] })
  const [editConfig, setEditConfig] = useState(false)
  const [configTemp, setConfigTemp] = useState({ aule: [], campi_extra: [] })
  const [filterAula, setFilterAula] = useState('tutte')
  const [noteModal, setNoteModal] = useState(null)
  const canEdit = canManage(user.ruolo, 'aule') || user.ruolo === 'superadmin'

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'aule').single()
      .then(({ data }) => {
        if (data?.valore) setConfig(data.valore)
      })
  }, [])

  if (loading) return <LoadingPage />

  const salvaConfig = async () => {
    try {
      const { error } = await supabase.from('configurazioni').upsert({ id: 'aule', valore: configTemp })
      if (error) throw error
      setConfig(configTemp)
      setEditConfig(false)
      reload()
    } catch (e) {
      alert('Errore salvataggio: ' + e.message)
    }
  }

  const aulaColor = (nome) => {
    const idx = config.aule.findIndex(a => a.nome === nome)
    return PALETTE_COLORS[idx % PALETTE_COLORS.length] || '#7f8c8d'
  }

  const filtrate = filterAula === 'tutte' ? prenotazioni : prenotazioni.filter(p => p.aula === filterAula)

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => goPublic('aule')}>🔗 Modulo pubblico</button>
        {canEdit && (
          <button className="btn btn-ghost" onClick={() => { setConfigTemp(JSON.parse(JSON.stringify(config))); setEditConfig(true) }}>
            ⚙️ Gestisci aule
          </button>
        )}
        {/* Filtro per aula */}
        {config.aule.length > 0 && (
          <select className="form-select" style={{ width: 'auto', padding: '8px 12px', minWidth: 160 }}
            value={filterAula} onChange={e => setFilterAula(e.target.value)}>
            <option value="tutte">Tutte le aule</option>
            {config.aule.map(a => <option key={a.id} value={a.nome}>{a.nome}</option>)}
          </select>
        )}
      </div>

      {/* Pillole aule */}
      {config.aule.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          {config.aule.map((a, i) => {
            const color = PALETTE_COLORS[i % PALETTE_COLORS.length]
            const cnt = prenotazioni.filter(p => p.aula === a.nome).length
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 999, background: color + '18', border: '2px solid ' + color }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
                <span style={{ fontWeight: 700, fontSize: '.85rem', color }}>{a.nome}</span>
                {a.capienza && <span style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>· cap. {a.capienza}</span>}
                <span style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>({cnt})</span>
              </div>
            )
          })}
        </div>
      )}

      <div className="tabs">
        {[['prenotazioni','📋 Prenotazioni'],['calendario','📅 Calendario']].map(([t,l]) => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</div>
        ))}
      </div>

      {tab === 'prenotazioni' && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '16px 20px', fontWeight: 800, borderBottom: '1px solid var(--border)', color: 'var(--primary)' }}>
            Prenotazioni ({filtrate.length})
          </div>
          {filtrate.length === 0
            ? <div className="alert alert-info" style={{ margin: 16 }}>Nessuna prenotazione.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Aula</th><th>Chi</th><th>Data</th><th>Orario</th><th>Note</th><th></th></tr></thead>
                <tbody>{filtrate.map(p => {
                  const c = aulaColor(p.aula)
                  return (
                    <tr key={p.id}>
                      <td>
                        <span style={{ padding: '4px 12px', borderRadius: 999, background: c + '20', color: c, fontWeight: 700, fontSize: '.8rem', whiteSpace: 'nowrap' }}>
                          {p.aula}
                        </span>
                      </td>
                      <td><b>{p.chi}</b></td>
                      <td>{p.data}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.ora_inizio} – {p.ora_fine}</td>
                      <td><small style={{ color: 'var(--text-muted)' }}>{p.note}</small></td>
                      <td>
                        {p.note_admin && (
                        <div style={{
                          fontSize: '.72rem', color: '#8e44ad', fontWeight: 600,
                          background: '#f3e8ff', borderRadius: 6, padding: '2px 7px',
                          marginBottom: 4, maxWidth: 160,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={p.note_admin}>
                          📝 {p.note_admin}
                        </div>
                      )}
                      <button className="btn btn-sm btn-ghost"
                        title={p.note_admin ? 'Modifica nota' : 'Aggiungi nota'}
                        onClick={() => setNoteModal({ tabella: 'prenotazioni_aule', prenotazione: p })}
                        style={{ color: p.note_admin ? '#8e44ad' : undefined,
                          borderColor: p.note_admin ? '#8e44ad' : undefined }}>
                        📝
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={async () => {
                          if (window.confirm('Eliminare questa prenotazione?')) {
                            await supabase.from('prenotazioni_aule').delete().eq('id', p.id)
                        logAudit({ user, azione: 'ELIMINA_PRENOTAZIONE_AULA', categoria: 'Prenotazioni',
                          dettaglio: `Eliminata prenotazione aula "${p.aula}" di ${p.chi} per il ${p.data} ${p.ora_inizio}-${p.ora_fine}`,
                          meta: { id: p.id, aula: p.aula, chi: p.chi, data: p.data } })
                        reload()
                          }
                        }}>🗑️</button>
                      </td>
                    </tr>
                  )
                })}</tbody>
              </table></div>
          }
        </div>
      )}
      {tab === 'calendario' && <Calendario prenotazioni={filtrate} />}

      {noteModal && <NoteModal tabella={noteModal.tabella} prenotazione={noteModal.prenotazione} user={user} onClose={() => { setNoteModal(null); reload() }} />}
      {/* Modal configurazione aule */}
      {editConfig && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditConfig(false)}>
          <div className="modal" style={{ maxWidth: 720 }}>
            <div className="modal-title">⚙️ Gestione Aule</div>
            <div className="tabs" style={{ marginBottom: 20 }}>
              {[['aule','🏫 Aule'],['campi','➕ Campi extra']].map(([t,l]) => {
                const [activeTab, setActiveTabLocal] = [configTemp._activeTab || 'aule', v => setConfigTemp(p => ({ ...p, _activeTab: v }))]
                return <div key={t} className={`tab ${activeTab === t ? 'active' : ''}`} onClick={() => setActiveTabLocal(t)}>{l}</div>
              })}
            </div>
            {(configTemp._activeTab || 'aule') === 'aule' && (
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '.88rem', marginBottom: 16 }}>
                  Aggiungi e gestisci le stanze fisiche dell'oratorio. Queste appariranno nel modulo pubblico di prenotazione.
                </p>
                {(configTemp.aule || []).map((a, i) => (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                    <input className="form-input" value={a.nome} placeholder="Nome stanza (es. Salone Don Bosco)"
                      onChange={e => setConfigTemp(p => ({ ...p, aule: p.aule.map((x, j) => j === i ? { ...x, nome: e.target.value } : x) }))} />
                    <input className="form-input" type="number" value={a.capienza || ''} placeholder="Capienza"
                      style={{ width: 100 }}
                      onChange={e => setConfigTemp(p => ({ ...p, aule: p.aule.map((x, j) => j === i ? { ...x, capienza: e.target.value } : x) }))} />
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: PALETTE_COLORS[i % PALETTE_COLORS.length], flexShrink: 0 }} />
                    <button className="btn btn-sm btn-danger" onClick={() => setConfigTemp(p => ({ ...p, aule: p.aule.filter((_, j) => j !== i) }))}>✕</button>
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={() => setConfigTemp(p => ({ ...p, aule: [...(p.aule || []), { id: uid(), nome: '', capienza: '' }] }))}>
                  + Aggiungi aula
                </button>
              </div>
            )}
            {(configTemp._activeTab || 'aule') === 'campi' && (
              <div>
                <div className="alert alert-info" style={{ marginBottom: 12, fontSize: '.85rem' }}>
                  Campi extra che appariranno nel modulo pubblico di prenotazione.
                </div>
                <EditorCampiExtra campi={configTemp.campi_extra || []} onChange={v => setConfigTemp(p => ({ ...p, campi_extra: v }))} />
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditConfig(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={salvaConfig}>💾 Salva configurazione</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── PUBLIC: AULE ─────────────────────────────────────────────────────────────
function PubAuleForm({ onBack, authUser, profilo }) {
  const [config, setConfig]   = useState({ aule: [], campi_extra: [] })
  const [imgPortfolio, setImgPortfolio] = useState(null)
  const [loadingCfg, setLoadingCfg] = useState(true)
  const [form, setForm]       = useState({ chi: '', email: '', telefono: '', aula: '', data: '', ora_inizio: '09:00', ora_fine: '10:00', note: '', dati_extra: {}, consenso_privacy: false })
  const [success, setSuccess] = useState(false)
  const [saving, setSaving]   = useState(false)
  const { isBloccata } = useDateBloccate()
  const set    = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setExtra = (id, val) => setForm(p => ({ ...p, dati_extra: { ...p.dati_extra, [id]: val } }))

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'aule').single()
      .then(({ data }) => {
        if (data?.valore) setConfig(data.valore)
        setLoadingCfg(false)
      })
    
    // Carica immagine portfolio se disponibile
    supabase.from('configurazioni').select('valore').eq('id', 'portfolio_spazi').maybeSingle()
      .then(({ data }) => {
        const spazio = data?.valore?.spazi?.find(s => s.collegamento_form === 'aule')
        if (spazio?.foto) setImgPortfolio(spazio.foto)
      })

    if (authUser && profilo) {
      setForm(p => ({
        ...p,
        chi: `${profilo.nome || ''} ${profilo.cognome || ''}`.trim(),
        email: authUser.email || '',
        telefono: profilo.telefono || '',
      }))
    }
  }, [authUser, profilo]) // eslint-disable-line

  const invia = async () => {
    if (!form.aula) { alert(`Seleziona un'aula.`); return }
    setSaving(true)
    // Anti-sovrapposizione: stessa aula + stessa data + orario sovrapposto
    const { data: esistentiAula } = await supabase
      .from('prenotazioni_aule').select('ora_inizio, ora_fine').eq('aula', form.aula).eq('data', form.data)
    if (esistentiAula && esistentiAula.length > 0) {
      const toMin = (t) => { const [h,m] = (t||'00:00').split(':').map(Number); return h*60+m }
      const conflitto = esistentiAula.some(p =>
        toMin(form.ora_inizio) < toMin(p.ora_fine) && toMin(form.ora_fine) > toMin(p.ora_inizio))
      if (conflitto) {
        alert(`⚠️ L'aula "${form.aula}" è già prenotata in questo orario. Scegli un orario diverso.`)
        setSaving(false); return
      }
    }
    const { error: errAula } = await supabase.from('prenotazioni_aule').insert([{
      ...form, utente_id: authUser?.id || null,
    }])
    if (errAula) { alert('Errore: ' + errAula.message); setSaving(false); return }
    logAudit({ user: { nome: form.chi, email: form.email || '', id: null },
      azione: 'NUOVA_PRENOTAZIONE_AULA', categoria: 'Prenotazioni',
      dettaglio: `${form.chi} ha prenotato l'aula "${form.aula}" per il ${form.data} ${form.ora_inizio}-${form.ora_fine}`,
      meta: { chi: form.chi, aula: form.aula, data: form.data, ora_inizio: form.ora_inizio, ora_fine: form.ora_fine } })
    sendPushNotification({
      titolo: '🏫 Nuova prenotazione stanza',
      corpo:  `${form.chi} ha prenotato l'aula "${form.aula}" per il ${form.data} ${form.ora_inizio}-${form.ora_fine}`,
      target_tipo: 'superadmin',
    })
    setSaving(false); setSuccess(true)
  }

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>🏫</div>
      <h2 style={{ color: 'var(--primary)' }}>Prenotazione inviata!</h2>
      <p style={{ color: 'var(--text-muted)', margin: '8px 0 24px' }}>Aula: <b>{form.aula}</b> — {form.data} {form.ora_inizio}–{form.ora_fine}</p>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center', marginTop:8 }}>
        <button className="btn btn-primary btn-lg" onClick={() => { setSuccess(false); setForm({ chi: '', email: '', telefono: '', aula: '', data: '', ora_inizio: '09:00', ora_fine: '10:00', note: '', dati_extra: {} }) }}>+ Nuova</button>
        {authUser && <button className="btn btn-success btn-lg" onClick={() => { onBack(); setTimeout(() => window.dispatchEvent(new CustomEvent('goto-area-personale')), 100) }}>👤 La mia area →</button>}
        <button className="btn btn-ghost btn-lg" onClick={onBack}>← Home</button>
      </div>
    </div></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🏫</div>
        <h1>Prenota una stanza</h1>
        <p>Oratorio di Sergnano · Solo per organizzatori</p>
      </div>
      <div className="card">
        {imgPortfolio && <img src={imgPortfolio} alt="Aule" style={{ width: '100%', height: 200, objectFit: 'cover', borderRadius: 12, marginBottom: 16 }} />}
        <BannerUtente authUser={authUser} profilo={profilo} />
        {loadingCfg ? <LoadingPage text="Caricamento..." /> : (<>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Nome / Gruppo *</label><input className="form-input" value={form.chi} onChange={e => set('chi', e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Email</label><input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></div>
          </div>
          <div className="form-group"><label className="form-label">Telefono</label><input className="form-input" type="tel" value={form.telefono} onChange={e => set('telefono', e.target.value)} /></div>

          {config.aule.length === 0
            ? <div className="alert alert-warn">Nessuna stanza configurata. Contatta l'amministratore dell'oratorio.</div>
            : (
              <div className="form-group">
                <label className="form-label">Stanza *</label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                  {config.aule.map((a, i) => {
                    const color = PALETTE_COLORS[i % PALETTE_COLORS.length]
                    return (
                      <button key={a.id} type="button" onClick={() => set('aula', a.nome)}
                        style={{
                          padding: '10px 18px', borderRadius: 12, border: '2px solid ' + color,
                          background: form.aula === a.nome ? color : color + '18',
                          color: form.aula === a.nome ? '#fff' : color,
                          cursor: 'pointer', fontWeight: 700, fontSize: '.88rem', transition: 'all .18s',
                        }}>
                        {a.nome}{a.capienza ? <span style={{ fontWeight: 400, opacity: .75, fontSize: '.78rem', marginLeft: 4 }}>· {a.capienza} posti</span> : ''}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          }

          <div className="form-row">
            <div className="form-group"><label className="form-label">Data *</label><input className="form-input" type="date" value={form.data} onChange={e => set('data', e.target.value)} min={today()} /></div>
            <div className="form-group"><label className="form-label">Ora inizio *</label><input className="form-input" type="time" value={form.ora_inizio} onChange={e => set('ora_inizio', e.target.value)} /></div>
          </div>
          <div className="form-group"><label className="form-label">Ora fine *</label><input className="form-input" type="time" value={form.ora_fine} onChange={e => set('ora_fine', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Note o richieste</label><textarea className="form-textarea" value={form.note} onChange={e => set('note', e.target.value)} placeholder="Eventuali necessità particolari..." /></div>

          {(config.campi_extra || []).length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>Informazioni aggiuntive</div>
              {config.campi_extra.map(campo => (
                <CampoExtra key={campo.id} campo={campo} value={form.dati_extra[campo.id]} onChange={val => setExtra(campo.id, val)} />
              ))}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
            <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`} style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={form.consenso_privacy}
                onChange={e => set('consenso_privacy', e.target.checked)} />
              <span style={{ fontSize: '.85rem' }}>
                Acconsento al trattamento dei dati personali ai sensi del GDPR (Reg. UE 2016/679) *
              </span>
            </label>
          </div>
          {form.data && isBloccata(form.data) && (
            <div className="alert alert-warn" style={{ marginBottom: 12 }}>
              🚫 Le aule non sono disponibili in questa data.
            </div>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-ghost" onClick={onBack}>← Indietro</button>
            <button className="btn btn-primary btn-lg" onClick={invia}
              disabled={saving || !form.chi || !form.data || !form.aula || !form.consenso_privacy || (form.data && isBloccata(form.data))}
              style={{ flex: 1 }}>
              {saving ? <><span className="spinner" /> Invio...</> : '📩 Prenota stanza'}
            </button>
          </div>
        </>)}
      </div>
    </div>
  )
}

// ─── PUBLIC: ACQUISTO BUONI PASTO ────────────────────────────────────────────
// ─── PUBLIC: PRENOTAZIONE TAVOLI FESTE ──────────────────────────────────────────
function PubTavoliForm({ onBack, authUser, profilo }) {
  const [imgPortfolio, setImgPortfolio] = useState(null)
  const [form, setForm] = useState({
    festa_id: '',
    nome_cognome: profilo?.nome && profilo?.cognome ? `${profilo.nome} ${profilo.cognome}` : '',
    persone: 2,
    data: '',
    ora: '',
    consenso_privacy: false
  })
  const [feste, setFeste] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    const carica = async () => {
      const { data } = await supabase.from('feste').select('*').eq('attivo', true).order('data_inizio', { ascending: true })
      setFeste(data || [])
      setLoading(false)
    }
    carica()

    supabase.from('configurazioni').select('valore').eq('id', 'portfolio_spazi').maybeSingle()
      .then(({ data }) => {
        const spazio = data?.valore?.spazi?.find(s => s.collegamento_form === 'tavoli')
        if (spazio?.foto) setImgPortfolio(spazio.foto)
      })
  }, [])

  const selFesta = feste.find(f => f.id === form.festa_id)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const invia = async () => {
    if (!form.festa_id || !form.nome_cognome || !form.data || !form.ora || !form.consenso_privacy) {
      alert('Compila tutti i campi obbligatori.'); return
    }
    setSaving(true)
    try {
      const payload = {
        festa_id: form.festa_id,
        nome_referente: form.nome_cognome,
        persone: form.persone,
        data: form.data,
        ora: form.ora,
        utente_id: authUser?.id || null,
        consenso_privacy: true
      }
      const { error } = await supabase.from('prenotazioni_tavoli').insert([payload])
      if (error) throw error

      sendPushNotification({
        titolo: '🍽️ Nuova prenotazione tavolo',
        corpo:  `${form.nome_cognome} per ${form.persone} persone il ${form.data} (${selFesta?.nome})`,
        target_tipo: 'superadmin'
      })

      setSuccess(true)
    } catch (e) { alert(e.message) }
    setSaving(false)
  }

  if (loading) return <div className="public-page"><LoadingPage /></div>

  if (success) return (
    <div className="public-page">
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ fontSize: '4rem', marginBottom: 16 }}>✅</div>
        <h2 style={{ color: 'var(--primary)', marginBottom: 8 }}>Prenotazione Ricevuta!</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>
          Grazie <b>{form.nome_cognome}</b>, abbiamo ricevuto la tua prenotazione per <b>{form.persone} persone</b> presso <b>{selFesta?.nome}</b>.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onBack}>Torna alla home</button>
      </div>
    </div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🍽️</div>
        <h1>Prenotazione Tavoli</h1>
        <p>Oratorio di Sergnano · Area Feste</p>
      </div>

      <div className="card">
        {imgPortfolio && <img src={imgPortfolio} alt="Area Feste" style={{ width: '100%', height: 200, objectFit: 'cover', borderRadius: 12, marginBottom: 16 }} />}
        
        {feste.length === 0 ? (
          <div className="alert alert-info">Al momento non ci sono feste con prenotazione tavoli attiva.</div>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">Seleziona la Festa *</label>
              <select className="form-select" value={form.festa_id} onChange={e => set('festa_id', e.target.value)}>
                <option value="">— Dove vuoi mangiare? —</option>
                {feste.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select>
            </div>

            {form.festa_id && (
              <div className="hp-fadeup">
                <div className="form-group"><label className="form-label">Nome e Cognome *</label>
                  <input className="form-input" value={form.nome_cognome} onChange={e => set('nome_cognome', e.target.value)} placeholder="Mario Rossi" />
                </div>

                <div className="form-row">
                  <div className="form-group"><label className="form-label">Data *</label>
                    <input type="date" className="form-input" 
                      min={selFesta?.data_inizio} max={selFesta?.data_fine}
                      value={form.data} onChange={e => set('data', e.target.value)} />
                  </div>
                  <div className="form-group"><label className="form-label">Ora *</label>
                    <input type="time" className="form-input" value={form.ora} onChange={e => set('ora', e.target.value)} />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Numero di persone *</label>
                  <input type="number" className="form-input" min="1" max="50" value={form.persone} onChange={e => set('persone', parseInt(e.target.value)||1)} />
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
                  <label className={`check-item ${form.consenso_privacy ? 'checked' : ''}`}>
                    <input type="checkbox" checked={form.consenso_privacy} onChange={e => set('consenso_privacy', e.target.checked)} />
                    <span style={{ fontSize: '.85rem' }}>Acconsento al trattamento dei dati personali *</span>
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                  <button className="btn btn-ghost" onClick={onBack}>← Indietro</button>
                  <button className="btn btn-primary btn-lg" onClick={invia} 
                    disabled={saving || !form.nome_cognome || !form.data || !form.ora || !form.consenso_privacy} 
                    style={{ flex: 1 }}>
                    {saving ? <><span className="spinner" /> Invio...</> : '📩 Prenota tavolo'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function PubBuoniForm({ eventoId, iscrizioneId, onBack }) {
  const [evento, setEvento] = useState(null)
  const [loading, setLoading] = useState(true)
  const [cercato, setCercato] = useState(false)
  const [cognome, setCognome] = useState('')
  const [risultati, setRisultati] = useState([])
  const [selezionato, setSelezionato] = useState(null)
  const [quantita, setQuantita] = useState(5)
  const [metodo, setMetodo] = useState('')
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const [buoniAttuali, setBuoniAttuali] = useState(0)

  useEffect(() => {
    const init = async () => {
      const { data: ev } = await supabase.from('eventi').select('*').eq('id', eventoId).single()
      setEvento(ev)
      if (iscrizioneId) {
        const { data: iData } = await supabase.from('iscrizioni').select('*').eq('id', iscrizioneId).single()
        if (iData) {
          const { data: bData } = await supabase.from('buoni_pasto').select('quantita')
            .eq('iscrizione_id', iscrizioneId).eq('evento_id', eventoId).maybeSingle()
          setSelezionato(iData)
          setBuoniAttuali(bData?.quantita || 0)
        }
      }
      setLoading(false)
    }
    init()
  }, [eventoId, iscrizioneId])

  if (loading) return <div className="public-page"><LoadingPage text="Caricamento..." /></div>
  if (!evento) return <div className="public-page"><div className="alert alert-danger">Evento non trovato.</div><button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onBack}>← Torna alla home</button></div>

  const prezzoUnitario = evento.prezzo_buono || 3.50

  const cerca = async () => {
    if (!cognome.trim()) return
    const { data } = await supabase.from('iscrizioni')
      .select('*').eq('evento_id', eventoId).ilike('cognome_bambino', `%${cognome.trim()}%`)
    setRisultati(data || [])
    setCercato(true)
  }

  const seleziona = async (i) => {
    setSelezionato(i)
    const { data } = await supabase.from('buoni_pasto').select('quantita').eq('iscrizione_id', i.id).eq('evento_id', eventoId).single()
    setBuoniAttuali(data?.quantita || 0)
  }

  const acquista = async () => {
    if (!selezionato || !quantita || !metodo) { alert('Compila tutti i campi.'); return }
    setSaving(true)
    const nuova = buoniAttuali + quantita

    // Aggiorna buoni_pasto con upsert su composite key
    const { error: errBuoni } = await supabase.from('buoni_pasto').upsert({
      iscrizione_id: selezionato.id,
      evento_id:     eventoId,
      quantita:      nuova,
      updated_at:    new Date().toISOString()
    })

    if (errBuoni) {
      alert('Errore salvataggio buoni: ' + errBuoni.message)
      setSaving(false)
      return
    }

    // Log acquisto
    const { error: errLog } = await supabase.from('log_pagamenti_buoni').insert([{
      evento_id:     eventoId,
      iscrizione_id: selezionato.id,
      nome_bambino:  `${selezionato.nome_bambino} ${selezionato.cognome_bambino}`,
      variazione:    quantita,
      quantita:      quantita,
      importo:       quantita * prezzoUnitario,
      metodo:        metodo,
      motivo:        `Acquisto pubblico — ${metodo}`,
      tipo:          'acquisto_pub',
    }])
    if (errLog) console.warn('Log buoni error:', errLog.message)

    setSaving(false)
    setBuoniAttuali(nuova)
    setSuccess(true)
  }

  // Se iscrizioneId fornito (area genitori), non mostrare mai la ricerca
  const mostraRicerca = !iscrizioneId
  const metodi = evento.metodi_pagamento || ['Contanti','POS/Carta','Bonifico']

  if (success) return (
    <div className="public-page"><div style={{ textAlign: 'center', padding: 48 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>🎟️</div>
      <h2 style={{ color: 'var(--primary)', marginBottom: 8 }}>Acquisto registrato!</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
        <b>{quantita} buoni pasto</b> aggiunti per <b>{selezionato.nome_bambino} {selezionato.cognome_bambino}</b>
      </p>
      <div className="price-box" style={{ maxWidth: 260, margin: '0 auto 24px' }}>
        <div className="price-total">{fmt(quantita * prezzoUnitario)}</div>
        <div className="price-breakdown">Importo da versare — {metodo}</div>
      </div>
      {mostraRicerca && <button className="btn btn-primary btn-lg" onClick={() => { setSuccess(false); setSelezionato(null); setCognome(''); setRisultati([]); setCercato(false); setQuantita(5); setMetodo('') }}>+ Nuovo acquisto</button>}
      <button className="btn btn-primary btn-lg" style={{ marginLeft: mostraRicerca ? 12 : 0 }} onClick={() => { setSuccess(false); setQuantita(5); setMetodo('') }}>🔄 Acquista altri buoni</button>
      <button className="btn btn-ghost btn-lg" style={{ marginLeft: 12 }} onClick={onBack}>← Torna alla tua area</button>
    </div></div>
  )

  // Se arriva dall'area genitori ma i dati non sono ancora caricati, mostra spinner
  if (iscrizioneId && !selezionato) return (
    <div className="public-page"><LoadingPage text="Caricamento dati bambino..." /></div>
  )

  return (
    <div className="public-page">
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🎟️</div>
        <h1>Acquisto Buoni Pasto</h1>
        <p>{evento.nome} · Oratorio di Sergnano</p>
      </div>
      <div className="card">
        {mostraRicerca && !selezionato ? (<>
          <h3 style={{ marginBottom: 16, color: 'var(--primary)' }}>🔍 Cerca il bambino</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input className="form-input" style={{ flex: 1 }} value={cognome} onChange={e => setCognome(e.target.value)}
              placeholder="Cognome del bambino" onKeyDown={e => e.key === 'Enter' && cerca()} />
            <button className="btn btn-primary" onClick={cerca}>Cerca</button>
          </div>
          {cercato && risultati.length === 0 && <div className="alert alert-warn">Nessun iscritto trovato con questo cognome.</div>}
          {risultati.map(i => (
            <div key={i.id} onClick={() => seleziona(i)}
              style={{ padding: '12px 16px', border: '2px solid var(--border)', borderRadius: 10, cursor: 'pointer', marginBottom: 8, transition: 'all .15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--primary)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
              <b>{i.nome_bambino} {i.cognome_bambino}</b>
              <div style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>{i.email_genitore}</div>
            </div>
          ))}
        </>) : (<>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>{selezionato.nome_bambino} {selezionato.cognome_bambino}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Buoni attuali: <b>{buoniAttuali}</b></div>
            </div>
            {!iscrizioneId && <button className="btn btn-sm btn-ghost" onClick={() => setSelezionato(null)}>↩ Cambia</button>}
          </div>
          <div className="form-group">
            <label className="form-label">Quantità buoni da acquistare *</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[1,5,10,20].map(q => (
                <button key={q} type="button" className={`btn ${quantita === q ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setQuantita(q)}>{q} {q === 1 ? 'buono' : 'buoni'}</button>
              ))}
            </div>
          </div>
          <div className="price-box" style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Totale da pagare</div>
            <div className="price-total">{fmt(quantita * prezzoUnitario)}</div>
            <div className="price-breakdown">{quantita} × {fmt(prezzoUnitario)} per buono</div>
          </div>
          <div className="form-group">
            <label className="form-label">Metodo di pagamento *</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {metodi.map(m => (
                <button key={m} type="button" className={`btn ${metodo === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMetodo(m)}>
                  {m === 'Contanti' ? '💵 Contanti' : m === 'POS/Carta' ? '💳 POS/Carta' : '🏦 Bonifico'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {!iscrizioneId && <button className="btn btn-ghost" onClick={() => setSelezionato(null)}>← Indietro</button>}
            <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={acquista}
              disabled={saving || !metodo}>
              {saving ? <><span className="spinner" /> Registrazione...</> : `🎟️ Acquista ${quantita} buoni`}
            </button>
          </div>
        </>)}
      </div>
    </div>
  )
}

// ─── AREA GENITORI ───────────────────────────────────────────────────────────
function GenitoreArea({ goTo, onBack, codiceAuto, resetToken }) {
  const [mode,          setMode]         = useState('login')
  const [username,      setUsername]     = useState('')
  const [password,      setPassword]     = useState('')
  const [showPwd,       setShowPwd]      = useState(false)
  const [error,         setError]        = useState('')
  const [loading,       setLoading]      = useState(false)
  const [genitore,      setGenitore]     = useState(null)
  const [datiCompleti,  setDatiCompleti] = useState({})
  const [openIscr] = useState(null) // eslint-disable-line
  const [sezioneAperta, setSezioneAperta] = useState({})
  const [pushStatus,    setPushStatus]   = useState('idle')
  // Reset password
  const [modeForgot,    setModeForgot]   = useState(false)
  const [resetEmail,    setResetEmail]   = useState('')
  const [resetMsg,      setResetMsg]     = useState('')
  const [resetSaving,   setResetSaving]  = useState(false)

  // Gestione reset token da URL
  const [modeReset,   setModeReset]   = useState(!!resetToken)
  const [nuovaPwd,    setNuovaPwd]    = useState('')
  const [nuovaPwdConf,setNuovaPwdConf]= useState('')
  const [resetOk,     setResetOk]     = useState(false)
  const [resetSavingPwd, setResetSavingPwd] = useState(false)

  const completaReset = async () => {
    if (!nuovaPwd || nuovaPwd.length < 8) { setError('Password troppo corta (min. 8 caratteri).'); return }
    if (nuovaPwd !== nuovaPwdConf) { setError('Le password non coincidono.'); return }
    setResetSavingPwd(true)
    // Verifica token valido e non scaduto
    const { data: isc } = await supabase.from('iscrizioni')
      .select('id,reset_token_scadenza')
      .eq('reset_token', resetToken).limit(1).single()
    if (!isc) { setError('Link non valido o già utilizzato.'); setResetSavingPwd(false); return }
    if (new Date(isc.reset_token_scadenza) < new Date()) {
      setError('Link scaduto. Richiedi un nuovo reset dalla pagina di login.')
      setResetSavingPwd(false); return
    }
    const nuovoHash = await hashPassword(nuovaPwd)
    await supabase.from('iscrizioni').update({
      password_genitore: nuovoHash, reset_token: null, reset_token_scadenza: null
    }).eq('id', isc.id)
    setResetOk(true)
    setResetSavingPwd(false)
    // Rimuovi token dall'URL
    window.history.replaceState({}, '', window.location.pathname)
  }

  const abilitaNotificheGenitore = async () => {
    if (pushStatus === 'ok') return
    setPushStatus('loading')
    try {
      // Usa l'ID dell'utente Auth (così i trigger possono trovare il dispositivo per utente_id)
      const { data: { user: authUser } } = await supabase.auth.getUser()
      const userId = authUser?.id || genitore?.iscrizioni?.[0]?.id || 'genitore_anonimo'
      const sub = await initWebPush(userId, 'genitore')
      setPushStatus(sub ? 'ok' : 'denied')
    } catch { setPushStatus('denied') }
  }

  const login = async () => {
    const cleanUser = (username || '').toLowerCase().trim()
    const cleanPass = (password || '').trim()

    if (!cleanUser || !cleanPass) {
      setError('Inserisci username e password.'); return
    }
    setLoading(true); setError('')

    // Hash della password inserita per confrontarla con quella salvata
    const pwdHash = await hashPassword(cleanPass)

    // Cerca per username + password hashata
    const { data: trovata, error: qErr } = await supabase
      .from('iscrizioni')
      .select('*')
      .eq('username_genitore', cleanUser)
      .eq('password_genitore', pwdHash)
      .limit(1)
      .single()

    if (qErr || !trovata) {
      setError('Username o password non corretti.')
      setLoading(false); return
    }

    // Cerca eventuali fratelli con lo stesso codice_famiglia
    let iscrizioni_trovate = [trovata]
    if (trovata.codice_famiglia) {
      const { data: fam } = await supabase
        .from('iscrizioni').select('*')
        .eq('codice_famiglia', trovata.codice_famiglia)
      if (fam && fam.length > 0) iscrizioni_trovate = fam
    }

    // Carica eventi associati
    const eventoIds = [...new Set(iscrizioni_trovate.map(i => i.evento_id))]
    const { data: eventiData } = await supabase.from('eventi').select('*').in('id', eventoIds)
    const evMap = {}
    ;(eventiData || []).forEach(e => { evMap[e.id] = e })
    const iscrizioni_con_evento = iscrizioni_trovate.map(i => ({ ...i, eventi: evMap[i.evento_id] || null }))

    setGenitore({ iscrizioni: iscrizioni_con_evento })
    setMode('dashboard')
    setLoading(false)
  }

  const caricaDatiIscrizione = async (iscr) => {
    if (datiCompleti[iscr.id]) return datiCompleti[iscr.id]
    const [{ data: pres }, { data: buoni }, { data: appello }, { data: logpag }, { data: comunicaz }] = await Promise.all([
      supabase.from('presenze').select('*').eq('iscrizione_id', iscr.id),
      supabase.from('buoni_pasto').select('*').eq('iscrizione_id', iscr.id).maybeSingle(),
      supabase.from('appello_giornaliero').select('*').eq('iscrizione_id', iscr.id).order('data'),
      supabase.from('log_pagamenti_buoni').select('*').eq('iscrizione_id', iscr.id).order('created_at', { ascending: false }),
      supabase.from('comunicazioni_inviate').select('*').eq('evento_id', iscr.evento_id).order('inviata_il', { ascending: false }).limit(20),
    ])
    const dati = {
      presenze:       pres     || [],
      buoni:          buoni?.quantita || 0,
      appello:        appello  || [],
      logPag:         logpag   || [],
      comunicazioni:  comunicaz || [],
    }
    setDatiCompleti(p => ({ ...p, [iscr.id]: dati }))
    return dati
  }

  // Apre/chiude una sezione (dettagli o comunicazioni) per un'iscrizione
  const apriSezione = async (iscr, sez) => {
    // Toggle: chiudi se già aperta la stessa sezione
    if (sezioneAperta[iscr.id] === sez) {
      setSezioneAperta(p => ({ ...p, [iscr.id]: null }))
      return
    }
    // Apri subito la sezione (mostrerà LoadingPage mentre carica)
    setSezioneAperta(p => ({ ...p, [iscr.id]: sez }))
    // Carica dati solo se non già presenti
    if (!datiCompleti[iscr.id]) {
      await caricaDatiIscrizione(iscr)
    }
  }

  // Schermata cambio password (da link reset)
  if (modeReset) return (
    <div className="public-page" style={{ maxWidth: 480 }}>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🔑</div>
        <h1>Reimposta password</h1>
        <p>Scegli una nuova password per l'Area Genitori</p>
      </div>
      <div className="card">
        {resetOk ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>✅</div>
            <h3 style={{ color: 'var(--green)', marginBottom: 8 }}>Password aggiornata!</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
              Puoi ora accedere con le tue nuove credenziali.
            </p>
            <button className="btn btn-primary btn-lg"
              onClick={() => { setModeReset(false); setResetOk(false) }}>
              → Vai al login
            </button>
          </div>
        ) : (<>
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="form-group">
            <label className="form-label">Nuova password *</label>
            <input className="form-input" type="password"
              value={nuovaPwd} onChange={e => setNuovaPwd(e.target.value)}
              placeholder="Minimo 8 caratteri" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Conferma nuova password *</label>
            <input className="form-input" type="password"
              value={nuovaPwdConf} onChange={e => setNuovaPwdConf(e.target.value)}
              placeholder="Ripeti la password"
              onKeyDown={e => e.key === 'Enter' && completaReset()} />
            {nuovaPwdConf && nuovaPwd !== nuovaPwdConf && (
              <div style={{ fontSize: '.78rem', color: 'var(--danger)', marginTop: 4 }}>
                ⚠️ Le password non coincidono
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
            onClick={completaReset} disabled={resetSavingPwd}>
            {resetSavingPwd
              ? <><span className="spinner" /> Salvataggio...</>
              : '🔒 Imposta nuova password'}
          </button>
        </>)}
      </div>
    </div>
  )

  if (mode === 'login') return (
    <div className="public-page" style={{ maxWidth: 480 }}>
      <div style={{ padding: '12px 0 0' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Torna alla home</button>
      </div>
      <div className="public-header">
        <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>👪</div>
        <h1>Area Genitori</h1>
        <p>Accedi con le credenziali scelte al momento dell'iscrizione</p>
      </div>
      <div className="card">
        {!modeForgot ? (<>
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="form-group">
            <label className="form-label">Username *</label>
            <input className="form-input" value={username}
              onChange={e => setUsername(e.target.value.toLowerCase())}
              onKeyDown={e => e.key === 'Enter' && login()}
              placeholder="es. mario.rossi"
              autoComplete="username" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Password *</label>
            <div style={{ position: 'relative' }}>
              <input className="form-input" type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && login()}
                placeholder="••••••••"
                autoComplete="current-password"
                style={{ paddingRight: 48 }} />
              <button type="button" onClick={() => setShowPwd(s => !s)}
                style={{ position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',
                  background:'none',border:'none',cursor:'pointer',fontSize:'1.2rem' }}>
                {showPwd ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 12 }}
            onClick={login} disabled={loading}>
            {loading ? <><span className="spinner" /> Accesso...</> : '🔓 Accedi'}
          </button>
          <button className="btn btn-ghost" style={{ width: '100%', fontSize: '.84rem' }}
            onClick={() => { setModeForgot(true); setResetMsg(''); setResetEmail('') }}>
            🔑 Ho dimenticato la password
          </button>
        </>) : (<>
          {/* Recupero password */}
          <div style={{ fontWeight: 800, marginBottom: 8, color: 'var(--primary)' }}>
            🔑 Recupero password
          </div>
          <p style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            Inserisci l'email usata al momento dell'iscrizione. Ti invieremo un link per reimpostare la password.
          </p>
          {resetMsg && <div className="alert alert-success">{resetMsg}</div>}
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="form-group">
            <label className="form-label">Email *</label>
            <input className="form-input" type="email" value={resetEmail}
              onChange={e => setResetEmail(e.target.value)}
              placeholder="tuaemail@gmail.com" autoFocus />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }}
            onClick={async () => {
              if (!resetEmail.trim()) { setError('Inserisci la tua email.'); return }
              setResetSaving(true); setError('')
              // Cerca l'iscrizione con quella email
              const { data: isc } = await supabase.from('iscrizioni')
                .select('id,nome_genitore,codice_accesso,username_genitore')
                .eq('email_genitore', resetEmail.toLowerCase().trim())
                .limit(1).single()
              if (!isc) {
                setError('Nessun account trovato con questa email.')
                setResetSaving(false); return
              }
              // Genera token reset (codice temporaneo)
              const token = Array.from({length:32}, () =>
                'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789'[
                  Math.floor(Math.random() * 57)]).join('')
              const scadenza = new Date(Date.now() + 60*60*1000).toISOString() // 1 ora
              await supabase.from('iscrizioni').update({
                reset_token: token, reset_token_scadenza: scadenza
              }).eq('id', isc.id)
              // Apri email con link reset
              const urlReset = `${window.location.origin}${window.location.pathname}?reset=${token}`
              const sogg = encodeURIComponent('[Oratorio Sergnano] Reimposta la tua password')
              const corpo = encodeURIComponent(
`Gentile ${isc.nome_genitore || 'Genitore'},

hai richiesto il reset della password per l'Area Genitori dell'Oratorio di Sergnano.

Clicca il link qui sotto per reimpostare la password (valido 1 ora):

${urlReset}

Se non hai richiesto questa operazione, ignora questa email.

Oratorio di Sergnano`)
              window.open(`mailto:${resetEmail}?subject=${sogg}&body=${corpo}`)
              setResetMsg('✅ Email aperta! Inviala al genitore per completare il reset.')
              setResetSaving(false)
            }}
            disabled={resetSaving}>
            {resetSaving ? <><span className="spinner" /> Elaborazione...</> : '📧 Invia link di reset'}
          </button>
          <button className="btn btn-ghost" style={{ width: '100%' }}
            onClick={() => { setModeForgot(false); setError('') }}>
            ← Torna al login
          </button>
        </>)}
      </div>
    </div>
  )

  // ── Sezione comunicazioni per il genitore ──────────────────────────────────
  const caricaComunicazioni = async (eventoId) => {
    const { data } = await supabase
      .from('comunicazioni_inviate')
      .select('*')
      .eq('evento_id', eventoId)
      .order('inviata_il', { ascending: false })
      .limit(20)
    return data || []
  }

  // Dashboard genitore — una o più iscrizioni per codice famiglia
  const iscrizioni_fam = genitore?.iscrizioni || (genitore?.iscrizione ? [genitore.iscrizione] : [])

  return (
    <div className="public-page" style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Home</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={abilitaNotificheGenitore}
            disabled={pushStatus === 'loading' || pushStatus === 'ok'}
            title={pushStatus === 'ok' ? 'Notifiche attive su questo dispositivo' : 'Attiva le notifiche push per ricevere aggiornamenti su questo dispositivo'}
            style={{
              background: pushStatus === 'ok' ? '#e8f5e9' : pushStatus === 'denied' ? '#fdecea' : 'var(--primary-pale)',
              color: pushStatus === 'ok' ? '#27ae60' : pushStatus === 'denied' ? 'var(--danger)' : 'var(--primary)',
              border: 'none', borderRadius: 10, padding: '7px 12px',
              fontWeight: 700, fontSize: '.82rem', cursor: pushStatus === 'ok' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6
            }}>
            {pushStatus === 'loading' ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Attivazione...</>
             : pushStatus === 'ok'     ? '🔔 Notifiche ON'
             : pushStatus === 'denied' ? '🔕 Notifiche negate'
             : '🔔 Attiva notifiche'}
          </button>
          <code style={{ background: 'var(--primary-pale)', color: 'var(--primary)', padding: '3px 10px', borderRadius: 6, fontWeight: 800, letterSpacing: 1 }}>
            {iscrizioni_fam[0]?.codice_accesso || iscrizioni_fam[0]?.codice_famiglia}
          </code>
          <button className="btn btn-sm btn-ghost" onClick={() => { setMode('login'); setCodice('') }}>🚪 Esci</button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: 'var(--primary)', fontWeight: 900, marginBottom: 4 }}>👪 Area Genitori</h2>
        {iscrizioni_fam.length > 1 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '.9rem' }}>{iscrizioni_fam.length} figli collegati a questo codice</p>
        )}
      </div>

      {iscrizioni_fam.map(iscr => {
        const evDash = iscr.eventi || {}
        const d      = datiCompleti[iscr.id]
        const isOpen = openIscr === iscr.id
        const sezione = sezioneAperta[iscr.id] // 'dettagli' | 'comunicazioni' | null

        return (
          <div key={iscr.id} className="card" style={{ padding: 0, marginBottom: 20 }}>
            {/* ── Header bambino ── */}
            <div style={{ padding: '18px 20px', background: 'linear-gradient(135deg,#E25B45,#FF8357)', color: '#fff', borderRadius: sezione ? '16px 16px 0 0' : 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: '1.1rem' }}>👦 {iscr.nome_bambino} {iscr.cognome_bambino}</div>
                  <div style={{ opacity: .8, fontSize: '.82rem', marginTop: 3 }}>🎪 {evDash.nome || 'Evento'} · {evDash.data_inizio} → {evDash.data_fine}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-sm"
                    style={{ background: sezione === 'dettagli' ? '#fff' : 'rgba(255,255,255,.2)', color: sezione === 'dettagli' ? 'var(--primary)' : '#fff', fontWeight: 700 }}
                    onClick={() => apriSezione(iscr, 'dettagli')}>
                    {sezione === 'dettagli' ? '▲ Chiudi' : '▼ Dettagli'}
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}
                    onClick={() => goTo('buoni', iscr.evento_id, { iscrizioneId: iscr.id })}>
                    🎟️ Buoni pasto
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ background: sezione === 'comunicazioni' ? '#fff' : 'rgba(255,255,255,.2)', color: sezione === 'comunicazioni' ? 'var(--primary)' : '#fff', fontWeight: 700 }}
                    onClick={() => apriSezione(iscr, 'comunicazioni')}>
                    📣 Comunicazioni
                  </button>
                </div>
              </div>
            </div>

            {/* ── Sezione Dettagli ── */}
            {sezione === 'dettagli' && (
              <div style={{ padding: 20 }}>
                {!d
                  ? <LoadingPage text="Caricamento..." />
                  : (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
                        <div className="stat-card" style={{ textAlign: 'center' }}>
                          <div className="stat-value" style={{ color: d.buoni < 0 ? 'var(--danger)' : d.buoni === 0 ? '#e65100' : 'var(--success)' }}>
                            {d.buoni < 0 ? `⚠️ ${d.buoni}` : d.buoni === 0 ? '⚠️ 0' : d.buoni}
                          </div>
                          <div className="stat-label">Buoni pasto</div>
                        </div>
                        <div className="stat-card" style={{ textAlign: 'center' }}>
                          <div className="stat-value">{d.appello.filter(a => a.presenza === 'P').length}</div>
                          <div className="stat-label">Presenze</div>
                        </div>
                        <div className="stat-card" style={{ textAlign: 'center' }}>
                          <div className="stat-value">{d.appello.filter(a => a.pranzo === 'mensa').length}</div>
                          <div className="stat-label">Pranzi mensa</div>
                        </div>
                      </div>

                      {d.appello.length > 0 && (
                        <div style={{ marginBottom: 20 }}>
                          <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>📅 Appello giornaliero</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {d.appello.map(a => (
                              <div key={a.data} style={{
                                padding: '6px 12px', borderRadius: 10, fontSize: '.78rem', fontWeight: 700,
                                background: a.presenza === 'P' ? '#d1fae5' : '#fee2e2',
                                color: a.presenza === 'P' ? '#065f46' : '#991b1b',
                              }}>
                                {new Date(a.data + 'T12:00:00').toLocaleDateString('it', { day: 'numeric', month: 'short' })}
                                {a.pranzo === 'mensa' ? ' 🍽️' : a.pranzo === 'sacco' ? ' 🎒' : a.pranzo === 'casa' ? ' 🏠' : ''}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {d.logPag.length > 0 && (
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 10, color: 'var(--primary)' }}>🎟️ Storico acquisti buoni</div>
                          <div className="table-wrap"><table>
                            <thead><tr><th>Data</th><th style={{textAlign:'center'}}>Buoni</th><th style={{textAlign:'right'}}>Importo</th><th>Metodo</th></tr></thead>
                            <tbody>{d.logPag.map(l => (
                              <tr key={l.id}>
                                <td style={{ fontSize: '.8rem' }}>{new Date(l.created_at).toLocaleString('it')}</td>
                                <td style={{ textAlign: 'center', fontWeight: 700 }}>{l.quantita > 0 ? '+' : ''}{l.quantita}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: l.importo >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt(Math.abs(l.importo))}{l.importo < 0 ? ' rimb.' : ''}</td>
                                <td><small>{l.metodo}</small></td>
                              </tr>
                            ))}</tbody>
                          </table></div>
                        </div>
                      )}
                    </div>
                  )
                }
              </div>
            )}

            {/* ── Sezione Comunicazioni ── */}
            {sezione === 'comunicazioni' && (
              <div style={{ padding: 20 }}>
                {!d
                  ? <LoadingPage text="Caricamento..." />
                  : d.comunicazioni.length === 0
                    ? <div className="alert alert-info">Nessuna comunicazione dall'oratorio per questo evento.</div>
                    : d.comunicazioni.map(c => (
                        <div key={c.id} style={{ border: '1.5px solid var(--border)', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                            <div style={{ fontWeight: 800, color: 'var(--primary)' }}>📣 {c.oggetto}</div>
                            <small style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: 12 }}>
                              {new Date(c.inviata_il).toLocaleDateString('it', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </small>
                          </div>
                          {(() => {
                            let testo = c.messaggio, img = null
                            try { const p = JSON.parse(c.messaggio); testo = p.testo || c.messaggio; img = p.immagine || null } catch(e) {}
                            return <>
                              <div style={{ whiteSpace: 'pre-wrap', fontSize: '.9rem', lineHeight: 1.6 }}>{testo}</div>
                              {img && <img src={img} alt="allegato" style={{ marginTop: 12, maxWidth: '100%', borderRadius: 10, border: '1.5px solid var(--border)' }} />}
                            </>
                          })()}
                        </div>
                      ))
                }
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}


// ─── ADMIN AUDIT LOG ─────────────────────────────────────────────────────────
function AdminAuditLog({ user, goBack }) {
  const [logs,      setLogs]      = useState([])
  const [loading,   setLoading]   = useState(true)
  const [filtroAdmin,  setFiltroAdmin]  = useState('')
  const [filtroAzione, setFiltroAzione] = useState('')
  const [filtroCateg,  setFiltroCateg]  = useState('')
  const [filtroData,   setFiltroData]   = useState('')
  const [pagina,    setPagina]    = useState(0)
  const PER_PAGINA = 50

  const CATEGORIE = ['Auth','Eventi','Iscritti','Buoni Pasto','Appello','Comunicazioni','Amministratori']
  const COLORI_AZIONE = {
    LOGIN:                  '#27ae60', LOGIN_FALLITO:     '#e74c3c', LOGOUT:              '#95a5a6',
    CREA_EVENTO:            '#2980b9', MODIFICA_EVENTO:   '#3498db', ELIMINA_EVENTO:      '#e74c3c',
    ELIMINA_ISCRITTO:       '#e74c3c', MODIFICA_ISCRITTO: '#f39c12',
    AGGIUNGE_BUONI:         '#27ae60', SCALA_BUONI:       '#e67e22', RIMBORSO_BUONI:      '#8e44ad',
    SALVA_APPELLO:          '#16a085',
    INVIA_COMUNICAZIONE:    '#2980b9', ELIMINA_COMUNICAZIONE: '#e74c3c',
    CREA_ADMIN:             '#27ae60', DISATTIVA_ADMIN:   '#e74c3c',
    CAMBIA_RUOLO_ADMIN:     '#f39c12', CAMBIA_PASSWORD_ADMIN: '#8e44ad',
  }

  const carica = async () => {
    setLoading(true)
    let q = supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(500)
    const { data, error } = await q
    if (error) { alert('Errore: ' + error.message); setLoading(false); return }
    setLogs(data || [])
    setLoading(false)
  }

  useEffect(() => { carica() }, [])

  const logsFiltrati = logs.filter(l => {
    if (filtroAdmin  && !(l.admin_nome || '').toLowerCase().includes(filtroAdmin.toLowerCase())) return false
    if (filtroAzione && l.azione !== filtroAzione) return false
    if (filtroCateg  && l.categoria !== filtroCateg) return false
    if (filtroData   && !l.created_at?.startsWith(filtroData)) return false
    return true
  })

  const paginati = logsFiltrati.slice(pagina * PER_PAGINA, (pagina + 1) * PER_PAGINA)
  const nPagine  = Math.ceil(logsFiltrati.length / PER_PAGINA)
  const azioniDisponibili = [...new Set(logs.map(l => l.azione))].sort()
  const adminDisponibili  = [...new Set(logs.map(l => l.admin_nome).filter(Boolean))].sort()

  // Statistiche rapide
  const oggi = new Date().toISOString().split('T')[0]
  const logsOggi   = logs.filter(l => l.created_at?.startsWith(oggi))
  const logsErrore = logs.filter(l => l.esito === 'errore')
  const ultimoLogin = logs.find(l => l.azione === 'LOGIN')

  const fmtData = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleDateString('it', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }} onClick={goBack}>← Dashboard</button>

      {/* Statistiche rapide */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Attività oggi',    val: logsOggi.length,   color: '#2980b9', icon: '📅' },
          { label: 'Totale log',       val: logs.length,        color: '#27ae60', icon: '📜' },
          { label: 'Errori / Falliti', val: logsErrore.length, color: '#e74c3c', icon: '⚠️' },
          { label: 'Ultimo accesso',   val: ultimoLogin ? fmtData(ultimoLogin.created_at).split(' ')[1] : '—',
            sub: ultimoLogin?.admin_nome, color: '#8e44ad', icon: '🔐' },
        ].map((s, i) => (
          <div key={i} className="stat-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 4 }}>{s.icon}</div>
            <div style={{ fontSize: s.label === 'Ultimo accesso' ? '1.1rem' : '1.8rem',
              fontWeight: 900, color: s.color, fontFamily: "'Nunito',sans-serif" }}>{s.val}</div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-muted)', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '.4px', marginTop: 3 }}>{s.label}</div>
            {s.sub && <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Filtri */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-muted)' }}>🔍 Filtra:</span>
          <select className="form-select" style={{ width: 'auto', padding: '6px 10px', fontSize: '.84rem' }}
            value={filtroAdmin} onChange={e => { setFiltroAdmin(e.target.value); setPagina(0) }}>
            <option value="">Tutti gli admin</option>
            {adminDisponibili.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="form-select" style={{ width: 'auto', padding: '6px 10px', fontSize: '.84rem' }}
            value={filtroCateg} onChange={e => { setFiltroCateg(e.target.value); setPagina(0) }}>
            <option value="">Tutte le categorie</option>
            {CATEGORIE.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="form-select" style={{ width: 'auto', padding: '6px 10px', fontSize: '.84rem' }}
            value={filtroAzione} onChange={e => { setFiltroAzione(e.target.value); setPagina(0) }}>
            <option value="">Tutte le azioni</option>
            {azioniDisponibili.map(a => <option key={a} value={a}>{a.replace(/_/g,' ')}</option>)}
          </select>
          <input type="date" className="form-input" style={{ width: 'auto', padding: '6px 10px', fontSize: '.84rem' }}
            value={filtroData} onChange={e => { setFiltroData(e.target.value); setPagina(0) }} />
          {(filtroAdmin || filtroCateg || filtroAzione || filtroData) && (
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
              onClick={() => { setFiltroAdmin(''); setFiltroCateg(''); setFiltroAzione(''); setFiltroData(''); setPagina(0) }}>
              ✕ Reset
            </button>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '.82rem', color: 'var(--text-muted)' }}>
            {logsFiltrati.length} risultati
          </span>
          <button className="btn btn-sm btn-ghost" onClick={carica}>🔄 Aggiorna</button>
          <button className="btn btn-sm btn-ghost" onClick={() => {
            const csv = ['"Data","Admin","Email","Categoria","Azione","Dettaglio","Esito"',
              ...logsFiltrati.map(l =>
                `"${fmtData(l.created_at)}","${l.admin_nome || ''}","${l.admin_email || ''}","${l.categoria || ''}","${l.azione || ''}","${(l.dettaglio || '').replace(/"/g,"'")}","${l.esito || 'ok'}"`)
            ].join('\n')
            const a = document.createElement('a')
            a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv)
            a.download = 'audit_log.csv'; a.click()
          }}>📥 Esporta CSV</button>
        </div>
      </div>

      {loading
        ? <LoadingPage text="Caricamento registro..." />
        : logsFiltrati.length === 0
          ? <div className="alert alert-info">Nessuna attività trovata con i filtri selezionati.</div>
          : (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>Data e ora</th>
                    <th>Admin</th>
                    <th>Categoria</th>
                    <th>Azione</th>
                    <th>Dettaglio</th>
                    <th style={{ textAlign: 'center' }}>Esito</th>
                  </tr></thead>
                  <tbody>
                    {paginati.map(l => (
                      <tr key={l.id}>
                        <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                          {fmtData(l.created_at)}
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, fontSize: '.85rem' }}>{l.admin_nome || '—'}</div>
                          <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{l.admin_email || ''}</div>
                        </td>
                        <td>
                          <span style={{ fontSize: '.76rem', background: 'var(--bg)',
                            border: '1px solid var(--border)', borderRadius: 20,
                            padding: '2px 9px', fontWeight: 600, color: 'var(--text-muted)' }}>
                            {l.categoria || '—'}
                          </span>
                        </td>
                        <td>
                          <span style={{
                            padding: '3px 10px', borderRadius: 20, fontSize: '.76rem', fontWeight: 700,
                            background: (COLORI_AZIONE[l.azione] || '#7f8c8d') + '20',
                            color: COLORI_AZIONE[l.azione] || '#7f8c8d',
                            whiteSpace: 'nowrap',
                          }}>
                            {(l.azione || '').replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td style={{ fontSize: '.83rem', maxWidth: 320 }}>
                          {l.dettaglio || '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span style={{
                            fontSize: '.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                            background: l.esito === 'errore' ? '#fdecea' : '#e8f5e9',
                            color: l.esito === 'errore' ? '#c62828' : '#2e7d32',
                          }}>
                            {l.esito === 'errore' ? '❌ errore' : '✅ ok'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Paginazione */}
              {nPagine > 1 && (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm btn-ghost" disabled={pagina === 0}
                    onClick={() => setPagina(p => Math.max(0, p - 1))}>‹ Prec</button>
                  {Array.from({ length: nPagine }, (_, i) => (
                    <button key={i}
                      className={`btn btn-sm ${pagina === i ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setPagina(i)}>
                      {i + 1}
                    </button>
                  ))}
                  <button className="btn btn-sm btn-ghost" disabled={pagina === nPagine - 1}
                    onClick={() => setPagina(p => Math.min(nPagine - 1, p + 1))}>Succ ›</button>
                </div>
              )}
            </>
          )
      }
    </div>
  )
}





function AdminHomepage({ user, goBack }) {
  const [tab, setTab] = useState('numeri')
  const DEFAULT_NUMERI = [
    { id: 'n1', val: '250+', label: 'Bambini ogni estate',  color: '#E25B45' },
    { id: 'n2', val: '15',   label: 'Animatori volontari',  color: '#FF8357' },
    { id: 'n3', val: '4',    label: 'Spazi prenotabili',     color: '#89D5C9' },
    { id: 'n4', val: '1948', label: 'Anno di fondazione',    color: '#ADC865' },
  ]
  const [numeri,     setNumeri]     = useState(DEFAULT_NUMERI)
  const [numSaving,  setNumSaving]  = useState(false)
  const [avvisi,     setAvvisi]     = useState([])
  const [avvLoading, setAvvLoading] = useState(true)
  const [avvForm,    setAvvForm]    = useState({ titolo: '', testo: '' })
  const [avvSaving,  setAvvSaving]  = useState(false)
  const [avvEdit,    setAvvEdit]    = useState(null)
  const [calEventi,  setCalEventi]  = useState([])
  const [calLoading, setCalLoading] = useState(true)
  const EMPTY_CAL = { titolo: '', data: '', orario: '', luogo: '' }
  const [calForm,    setCalForm]    = useState(EMPTY_CAL)
  const [calSaving,  setCalSaving]  = useState(false)
  const [calEdit,    setCalEdit]    = useState(null)

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id','homepage_numeri').maybeSingle()
      .then(({ data }) => { if (data?.valore?.numeri) setNumeri(data.valore.numeri) })
    supabase.from('avvisi_pubblici').select('*').order('created_at', { ascending: false })
      .then(({ data }) => { setAvvisi(data || []); setAvvLoading(false) })
    supabase.from('calendario_homepage').select('*').order('data', { ascending: true })
      .then(({ data }) => { setCalEventi(data || []); setCalLoading(false) })
  }, [])

  const ricaricaAvvisi = () => {
    setAvvLoading(true)
    supabase.from('avvisi_pubblici').select('*').order('created_at', { ascending: false })
      .then(({ data }) => { setAvvisi(data || []); setAvvLoading(false) })
  }
  const ricaricaCal = () => {
    setCalLoading(true)
    supabase.from('calendario_homepage').select('*').order('data', { ascending: true })
      .then(({ data }) => { setCalEventi(data || []); setCalLoading(false) })
  }
  const salvaNumeri = async () => {
    setNumSaving(true)
    await supabase.from('configurazioni').upsert({ id: 'homepage_numeri', valore: { numeri } })
    logAudit({ user, azione: 'MODIFICA_NUMERI_HP', categoria: 'Homepage',
      dettaglio: 'Aggiornati numeri homepage pubblica' })
    setNumSaving(false); alert('\u2705 Numeri salvati!')
  }
  const salvaAvviso = async () => {
    if (!avvForm.titolo.trim()) { alert('Inserisci un titolo.'); return }
    setAvvSaving(true)
    try {
      if (avvEdit) {
        await supabase.from('avvisi_pubblici').update({ titolo: avvForm.titolo, testo: avvForm.testo }).eq('id', avvEdit)
      } else {
        const { error } = await supabase.from('avvisi_pubblici').insert([{ titolo: avvForm.titolo, testo: avvForm.testo, attivo: true }])
        if (error) throw error
      }
      logAudit({ user, azione: avvEdit ? 'MODIFICA_AVVISO' : 'CREA_AVVISO', categoria: 'Homepage',
        dettaglio: `${avvEdit ? 'Modificato' : 'Creato'} avviso "${avvForm.titolo}"`,
        meta: { titolo: avvForm.titolo } })

      if (!avvEdit) {
        sendPushNotification({
          titolo: `📢 Nuovo Avviso Oratorio`,
          corpo: avvForm.titolo,
          target_tipo: 'all',
          url: '/'
        })
      }

      setAvvForm({ titolo: '', testo: '' }); setAvvEdit(null); ricaricaAvvisi()
    } catch (e) {
      alert('Errore salvataggio avviso: ' + e.message)
    } finally {
      setAvvSaving(false)
    }
  }
  const eliminaAvviso = async (id) => {
    if (!window.confirm('Eliminare questo avviso?')) return
    const av = avvisi.find(a => a.id === id)
    await supabase.from('avvisi_pubblici').delete().eq('id', id)
    logAudit({ user, azione: 'ELIMINA_AVVISO', categoria: 'Homepage',
      dettaglio: `Eliminato avviso "${av?.titolo || ''}"` })
    ricaricaAvvisi()
  }
  const toggleAvviso = async (av) => {
    await supabase.from('avvisi_pubblici').update({ attivo: !av.attivo }).eq('id', av.id); ricaricaAvvisi()
  }
  const iniziaEditAvviso = (av) => { setAvvEdit(av.id); setAvvForm({ titolo: av.titolo, testo: av.testo || '' }) }
  const salvaCalEvento = async () => {
    if (!calForm.titolo.trim() || !calForm.data) { alert('Titolo e data obbligatori.'); return }
    setCalSaving(true)
    if (calEdit) {
      await supabase.from('calendario_homepage').update({ titolo: calForm.titolo, data: calForm.data, orario: calForm.orario, luogo: calForm.luogo }).eq('id', calEdit)
    } else {
      await supabase.from('calendario_homepage').insert([{ titolo: calForm.titolo, data: calForm.data, orario: calForm.orario, luogo: calForm.luogo }])
    }
    logAudit({ user, azione: calEdit ? 'MODIFICA_APPUNTAMENTO' : 'CREA_APPUNTAMENTO', categoria: 'Homepage',
      dettaglio: `${calEdit ? 'Modificato' : 'Creato'} appuntamento "${calForm.titolo}" (${calForm.data})`,
      meta: { titolo: calForm.titolo, data: calForm.data } })

    if (!calEdit) {
      const dataFmt = new Date(calForm.data + 'T12:00:00').toLocaleDateString('it', { day: 'numeric', month: 'long' })
      sendPushNotification({
        titolo: `📅 Evento: ${calForm.titolo}`,
        corpo: `In programma il ${dataFmt} ${calForm.orario ? `alle ${calForm.orario}` : ''}`,
        target_tipo: 'all',
        url: '/'
      })
    }

    setCalSaving(false); setCalForm(EMPTY_CAL); setCalEdit(null); ricaricaCal()
  }
  const eliminaCalEvento = async (id) => {
    if (!window.confirm('Eliminare questo appuntamento?')) return
    const calEv = calEventi.find(e => e.id === id)
    await supabase.from('calendario_homepage').delete().eq('id', id)
    logAudit({ user, azione: 'ELIMINA_APPUNTAMENTO', categoria: 'Homepage',
      dettaglio: `Eliminato appuntamento "${calEv?.titolo || ''}"` })
    ricaricaCal()
  }
  const iniziaEditCal = (ev) => { setCalEdit(ev.id); setCalForm({ titolo: ev.titolo, data: ev.data, orario: ev.orario || '', luogo: ev.luogo || '' }) }

  return (
    <div className="content">
      <div className="card-header" style={{ marginBottom: 20 }}>
        <div>
          <div className="card-title" style={{ fontSize: '1.2rem' }}>Gestione Homepage</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginTop: 4 }}>Modifica i contenuti della pagina pubblica</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={goBack}>Indietro</button>
      </div>
      <div className="tabs" style={{ marginBottom: 24 }}>
        {[{ id:'numeri', label:'\ud83d\udd22 Numeri' },{ id:'avvisi', label:'\ud83d\udccb Avvisi' },{ id:'calendario', label:'\ud83d\udcc5 Appuntamenti' }].map(t => (
          <div key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>
      {tab === 'numeri' && (
        <div>
          <div className="alert alert-info" style={{ marginBottom: 20 }}> Questi 4 numeri appaiono nella sezione "L'oratorio in numeri" della homepage pubblica.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginBottom: 24 }}>
            {numeri.map((n, i) => (
              <div key={n.id} className="card" style={{ borderTop: `3px solid ${n.color}`, paddingTop: 18 }}>
                <div style={{ textAlign: 'center', marginBottom: 14, padding: '10px', background: 'var(--bg)', borderRadius: 10 }}>
                  <div style={{ fontSize: '1.8rem', fontWeight: 900, color: n.color, fontFamily: "'Nunito',sans-serif" }}>{n.val}</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginTop: 3 }}>{n.label}</div>
                </div>
                <div className="form-group" style={{ marginBottom: 10 }}>
                  <label className="form-label">Valore</label>
                  <input className="form-input" value={n.val} onChange={e => setNumeri(prev => prev.map((x,j) => j===i ? {...x, val: e.target.value} : x))} />
                </div>
                <div className="form-group" style={{ marginBottom: 10 }}>
                  <label className="form-label">Etichetta</label>
                  <input className="form-input" value={n.label} onChange={e => setNumeri(prev => prev.map((x,j) => j===i ? {...x, label: e.target.value} : x))} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Colore</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="color" value={n.color} onChange={e => setNumeri(prev => prev.map((x,j) => j===i ? {...x, color: e.target.value} : x))}
                      style={{ width: 40, height: 36, borderRadius: 8, border: '1.5px solid var(--border)', cursor: 'pointer', padding: 2 }} />
                    <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{n.color}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary" onClick={salvaNumeri} disabled={numSaving}>
            {numSaving ? <><span className="spinner" /> Salvataggio...</> : '\ud83d\udcbe Salva numeri'}
          </button>
        </div>
      )}
      {tab === 'avvisi' && (
        <div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 800, fontSize: '.96rem', color: 'var(--primary)', marginBottom: 16 }}>
              {avvEdit ? '\u270f\ufe0f Modifica avviso' : '\u2795 Nuovo avviso'}
            </div>
            <div className="form-group">
              <label className="form-label">Titolo *</label>
              <input className="form-input" placeholder="es. Bar chiuso luned\u00ec" value={avvForm.titolo} onChange={e => setAvvForm(p => ({...p, titolo: e.target.value}))} />
            </div>
            <div className="form-group">
              <label className="form-label">Testo (facoltativo)</label>
              <textarea className="form-textarea" rows={3} placeholder="Descrizione breve..." value={avvForm.testo} onChange={e => setAvvForm(p => ({...p, testo: e.target.value}))} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={salvaAvviso} disabled={avvSaving}>
                {avvSaving ? <><span className="spinner" /> Salvo...</> : avvEdit ? '\ud83d\udcbe Aggiorna' : '\u2795 Aggiungi'}
              </button>
              {avvEdit && <button className="btn btn-ghost" onClick={() => { setAvvEdit(null); setAvvForm({ titolo: '', testo: '' }) }}>Annulla</button>}
            </div>
          </div>
          {avvLoading ? <LoadingPage text="Caricamento avvisi..." /> : avvisi.length === 0
            ? <div className="alert alert-info">Nessun avviso. Aggiungine uno sopra.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Titolo</th><th>Testo</th><th>Stato</th><th>Data</th><th></th></tr></thead>
                <tbody>{avvisi.map(av => (
                  <tr key={av.id}>
                    <td style={{ fontWeight: 700 }}>{av.titolo}</td>
                    <td><span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>{(av.testo || '\u2014').substring(0,60)}{av.testo?.length > 60 ? '\u2026' : ''}</span></td>
                    <td>
                      <button onClick={() => toggleAvviso(av)} style={{
                        border: 'none', borderRadius: 20, padding: '3px 12px', fontSize: '.75rem', fontWeight: 700, cursor: 'pointer',
                        background: av.attivo ? '#e8f5e9' : '#fee2e2', color: av.attivo ? '#2e7d32' : '#c62828',
                      }}>
                        {av.attivo ? '\u2705 Visibile' : '\ud83d\udd34 Nascosto'}
                      </button>
                    </td>
                    <td style={{ fontSize: '.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {av.created_at ? new Date(av.created_at).toLocaleDateString('it') : '\u2014'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => iniziaEditAvviso(av)}>\u270f\ufe0f</button>
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => eliminaAvviso(av.id)}>\ud83d\uddd1\ufe0f</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}
      {tab === 'calendario' && (
        <div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 800, fontSize: '.96rem', color: 'var(--primary)', marginBottom: 16 }}>
              {calEdit ? '\u270f\ufe0f Modifica appuntamento' : '\u2795 Nuovo appuntamento'}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Titolo *</label>
                <input className="form-input" placeholder="es. Festa del Patrono" value={calForm.titolo} onChange={e => setCalForm(p => ({...p, titolo: e.target.value}))} />
              </div>
              <div className="form-group">
                <label className="form-label">Data *</label>
                <input className="form-input" type="date" value={calForm.data} onChange={e => setCalForm(p => ({...p, data: e.target.value}))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Orario</label>
                <input className="form-input" placeholder="es. 16:00" value={calForm.orario} onChange={e => setCalForm(p => ({...p, orario: e.target.value}))} />
              </div>
              <div className="form-group">
                <label className="form-label">Luogo</label>
                <input className="form-input" placeholder="es. Cortile" value={calForm.luogo} onChange={e => setCalForm(p => ({...p, luogo: e.target.value}))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={salvaCalEvento} disabled={calSaving}>
                {calSaving ? <><span className="spinner" /> Salvo...</> : calEdit ? '\ud83d\udcbe Aggiorna' : '\u2795 Aggiungi'}
              </button>
              {calEdit && <button className="btn btn-ghost" onClick={() => { setCalEdit(null); setCalForm(EMPTY_CAL) }}>Annulla</button>}
            </div>
          </div>
          {calLoading ? <LoadingPage text="Caricamento..." /> : calEventi.length === 0
            ? <div className="alert alert-info">Nessun appuntamento. Aggiungine uno sopra.</div>
            : <div className="table-wrap"><table>
                <thead><tr><th>Data</th><th>Titolo</th><th>Orario</th><th>Luogo</th><th></th></tr></thead>
                <tbody>{calEventi.map(ev => (
                  <tr key={ev.id}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>
                      {new Date(ev.data + 'T12:00:00').toLocaleDateString('it', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </td>
                    <td style={{ fontWeight: 600 }}>{ev.titolo}</td>
                    <td>{ev.orario || '\u2014'}</td>
                    <td>{ev.luogo || '\u2014'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => iniziaEditCal(ev)}>\u270f\ufe0f</button>
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => eliminaCalEvento(ev.id)}>\ud83d\uddd1\ufe0f</button>
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
          }
        </div>
      )}
    </div>
  )
}


// ─── ADMIN ADMINS ─────────────────────────────────────────────────────────────
// ─── ADMIN FESTE ─────────────────────────────────────────────────────────────
function AdminFeste({ user, goPublic, goBack }) {
  const { data: feste, loading: loadFeste, reload: reloadFeste } = useSupabaseData('feste', { order: 'data_inizio' })
  const { data: prenotazioni, loading: loadPren, reload: reloadPren } = useSupabaseData('prenotazioni_tavoli', { order: 'data' })
  
  const [tab, setTab] = useState('feste')
  const [modalFesta, setModalFesta] = useState(null)
  const [filterFesta, setFilterFesta] = useState('tutte')
  const [noteModal, setNoteModal] = useState(null)

  const salvaFesta = async (festa) => {
    const { error } = await supabase.from('feste').upsert(festa)
    if (error) alert(error.message)
    else { setModalFesta(null); reloadFeste() }
  }

  const cambiaStato = async (id, stato) => {
    await supabase.from('prenotazioni_tavoli').update({ stato }).eq('id', id)
    reloadPren()
  }

  const filtrate = filterFesta === 'tutte' 
    ? prenotazioni 
    : prenotazioni.filter(p => p.festa_id === filterFesta)

  if (loadFeste || loadPren) return <LoadingPage />

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      
      <div className="tabs">
        <div className={`tab ${tab === 'feste' ? 'active' : ''}`} onClick={() => setTab('feste')}>🥳 Gestione Feste</div>
        <div className={`tab ${tab === 'prenotazioni' ? 'active' : ''}`} onClick={() => setTab('prenotazioni')}>🍽️ Prenotazioni Tavoli</div>
        <div className={`tab ${tab === 'calendario' ? 'active' : ''}`} onClick={() => setTab('calendario')}>📅 Calendario</div>
      </div>

      {tab === 'feste' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div className="card-title">Feste in programma</div>
            <button className="btn btn-primary btn-sm" onClick={() => setModalFesta({ nome: '', data_inizio: today(), data_fine: today(), attivo: true })}>+ Nuova Festa</button>
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th>Nome</th><th>Periodo</th><th>Stato</th><th>Azioni</th></tr></thead>
            <tbody>{feste.map(f => (
              <tr key={f.id}>
                <td><b>{f.nome}</b></td>
                <td>{f.data_inizio} → {f.data_fine}</td>
                <td><span className={`badge ${f.attivo ? 'badge-success' : 'badge-ghost'}`}>{f.attivo ? 'Attiva' : 'Chiusa'}</span></td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setModalFesta(f)}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('Eliminare?')) { await supabase.from('feste').delete().eq('id', f.id); reloadFeste() } }}>🗑️</button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {tab === 'prenotazioni' && (
        <div className="card">
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="card-title" style={{ margin: 0 }}>Riepilogo Prenotazioni ({filtrate.length})</div>
            <select className="form-select" style={{ width: 'auto' }} value={filterFesta} onChange={e => setFilterFesta(e.target.value)}>
              <option value="tutte">Tutte le feste</option>
              {feste.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={() => goPublic('tavoli')}>🔗 Apri modulo pubblico</button>
          </div>

          {filtrate.length === 0 ? <div className="alert alert-info">Nessuna prenotazione ricevuta.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Data/Ora</th><th>Referente</th><th>Persone</th><th>Stato</th><th>Festa</th><th></th></tr></thead>
              <tbody>{filtrate.map(p => {
                const festa = feste.find(f => f.id === p.festa_id)
                return (
                  <tr key={p.id}>
                    <td><b>{p.data}</b><br/><small>{p.ora}</small></td>
                    <td><b>{p.nome_referente}</b><br/><small>{p.telefono}</small></td>
                    <td style={{ textAlign: 'center' }}><b>{p.persone}</b></td>
                    <td>
                      <select className="form-select" style={{ width: 'auto', padding: '4px 8px', fontSize: '.8rem' }}
                        value={p.stato} onChange={e => cambiaStato(p.id, e.target.value)}>
                        <option value="in_attesa">⏳ In attesa</option>
                        <option value="confermata">✅ Confermata</option>
                        <option value="annullata">❌ Annullata</option>
                      </select>
                    </td>
                    <td><small>{festa?.nome || '—'}</small></td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => setNoteModal({ tabella: 'prenotazioni_tavoli', prenotazione: p })}>📝</button>
                        <button className="btn btn-sm btn-danger" onClick={async () => { if (window.confirm('Eliminare?')) { await supabase.from('prenotazioni_tavoli').delete().eq('id', p.id); reloadPren() } }}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          )}
        </div>
      )}

      {tab === 'calendario' && <Calendario prenotazioni={filtrate} />}
      {noteModal && <NoteModal tabella={noteModal.tabella} prenotazione={noteModal.prenotazione} user={user} onClose={() => { setNoteModal(null); reloadPren() }} />}
      
      {modalFesta && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModalFesta(null)}>
          <div className="modal">
            <div className="modal-title">{modalFesta.id ? '✏️ Modifica Festa' : '🥳 Nuova Festa'}</div>
            <div className="form-group"><label className="form-label">Nome Festa *</label><input className="form-input" value={modalFesta.nome} onChange={e => setModalFesta({...modalFesta, nome: e.target.value})} /></div>
            <div className="form-row">
              <div className="form-group"><label className="form-label">Data inizio *</label><input type="date" className="form-input" value={modalFesta.data_inizio} onChange={e => setModalFesta({...modalFesta, data_inizio: e.target.value})} /></div>
              <div className="form-group"><label className="form-label">Data fine *</label><input type="date" className="form-input" value={modalFesta.data_fine} onChange={e => setModalFesta({...modalFesta, data_fine: e.target.value})} /></div>
            </div>
            <label className={`check-item ${modalFesta.attivo ? 'checked' : ''}`} style={{ marginTop: 8 }}>
              <input type="checkbox" checked={modalFesta.attivo} onChange={e => setModalFesta({...modalFesta, attivo: e.target.checked})} />
              <span>Attiva (visibile nel modulo pubblico)</span>
            </label>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setModalFesta(null)}>Annulla</button>
              <button className="btn btn-primary" onClick={() => salvaFesta(modalFesta)}>Salva</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ADMIN PORTFOLIO ─────────────────────────────────────────────────────────────
function AdminPortfolio({ user, goBack }) {
  const [config, setConfig] = useState({ spazi: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editIdx, setEditIdx] = useState(null)
  const [form, setForm] = useState({ nome: '', descrizione: '', foto: '', icona: '🏠', ordine: 0, collegamento_form: '' })

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'portfolio_spazi').maybeSingle()
      .then(({ data }) => {
        if (data?.valore) setConfig(data.valore)
        setLoading(false)
      })
  }, [])

  const salva = async (nuovaLista) => {
    setSaving(true)
    try {
      const nuovaCfg = { spazi: nuovaLista.sort((a,b) => (a.ordine||0) - (b.ordine||0)) }
      await supabase.from('configurazioni').upsert({ id: 'portfolio_spazi', valore: nuovaCfg })
      setConfig(nuovaCfg)
      setEditIdx(null)
      setForm({ nome: '', descrizione: '', foto: '', icona: '🔗', ordine: 0, collegamento_form: '' })
    } catch (e) { alert(e.message) }
    setSaving(false)
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      const url = await uploadFile(file, 'portfolio')
      setForm(p => ({ ...p, foto: url }))
    } catch (e) { alert('Errore caricamento: ' + e.message) }
    setSaving(false)
  }

  const aggiungi = () => {
    const nuova = [...config.spazi, { ...form, id: uid() }]
    salva(nuova)
  }

  const modifica = () => {
    const nuova = config.spazi.map((s, i) => i === editIdx ? { ...form } : s)
    salva(nuova)
  }

  const rimuovi = (idx) => {
    if (!window.confirm('Rimuovere questo spazio?')) return
    const nuova = config.spazi.filter((_, i) => i !== idx)
    salva(nuova)
  }

  if (loading) return <LoadingPage />

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={goBack}>← Dashboard</button>
      
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>{editIdx !== null ? '✏️ Modifica Spazio' : '➕ Aggiungi Spazio al Portfolio'}</div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Nome Spazio *</label>
            <input className="form-input" value={form.nome} onChange={e => setForm(p => ({ ...p, nome: e.target.value }))} placeholder="es. Sala Cinema" />
          </div>
          <div className="form-group"><label className="form-label">Icona (Emoji)</label>
            <input className="form-input" value={form.icona} onChange={e => setForm(p => ({ ...p, icona: e.target.value }))} placeholder="" />
          </div>
        </div>

        <div className="form-group">
          <label className={`check-item ${form.collegamento_form ? 'checked' : ''}`} style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={!!form.collegamento_form} onChange={e => setForm(p => ({ ...p, collegamento_form: e.target.checked ? 'campetto' : '' }))} />
            <span>🔗 Collega questa foto a un modulo di prenotazione</span>
          </label>
          {form.collegamento_form && (
            <select className="form-select" value={form.collegamento_form} onChange={e => setForm(p => ({ ...p, collegamento_form: e.target.value }))}>
              <option value="campetto">⚽ Campetto</option>
              <option value="sala">🎉 Sala Feste</option>
              <option value="appartamento">🏡 Appartamento</option>
              <option value="aule">🏫 Aule Interne</option>
              <option value="tavoli">🍽️ Prenotazione Tavoli (Feste)</option>
              <option value="eventi">🎪 Iscrizione Eventi (Grest)</option>
            </select>
          )}
        </div>
        <div className="form-group"><label className="form-label">Descrizione *</label>
          <textarea className="form-textarea" value={form.descrizione} onChange={e => setForm(p => ({ ...p, descrizione: e.target.value }))} placeholder="Descrivi lo spazio e cosa si può fare..." />
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Foto dello spazio</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="form-input" value={form.foto} onChange={e => setForm(p => ({ ...p, foto: e.target.value }))} placeholder="https://... o carica file" />
              <label className="btn btn-ghost" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                📁 Carica
                <input type="file" hidden accept="image/*" onChange={handleFileUpload} />
              </label>
            </div>
            {form.foto && <img src={form.foto} alt="preview" style={{ marginTop: 8, height: 60, borderRadius: 8 }} />}
          </div>
          <div className="form-group"><label className="form-label">Ordine visualizzazione</label>
            <input type="number" className="form-input" value={form.ordine} onChange={e => setForm(p => ({ ...p, ordine: parseInt(e.target.value)||0 }))} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={editIdx !== null ? modifica : aggiungi} disabled={saving || !form.nome || !form.descrizione}>
            {saving ? <span className="spinner" /> : (editIdx !== null ? '💾 Aggiorna' : '➕ Aggiungi')}
          </button>
          {editIdx !== null && <button className="btn btn-ghost" onClick={() => { setEditIdx(null); setForm({ nome: '', descrizione: '', foto: '', icona: '', ordine: 0 }) }}>Annulla</button>}
        </div>
      </div>

      <div className="grid-3">
        {config.spazi.map((s, i) => (
          <div key={s.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {s.foto && <img src={s.foto} alt={s.nome} style={{ width: '100%', height: 140, objectFit: 'cover' }} />}
            <div style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: '1.4rem' }}>{s.icona}</span>
                <b style={{ fontSize: '1.05rem' }}>{s.nome}</b>
              </div>
              <p style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: 16, minHeight: 40 }}>{s.descrizione}</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-sm btn-ghost" onClick={() => { setEditIdx(i); setForm(s) }}>✏️</button>
                <button className="btn btn-sm btn-danger" onClick={() => rimuovi(i)}>🗑️</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AdminAdmins({ user, goBack }) {
  const { data: admins, loading, reload } = useSupabaseData('admins', { order: 'created_at', asc: true })
  const [showAdd,    setShowAdd]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [newAdmin,   setNewAdmin]   = useState({ nome: '', email: '', password: '', ruolo: 'admin_segreteria' })
  const [changePwd,  setChangePwd]  = useState(null)
  const [tabAdmins,  setTabAdmins]  = useState('admins') // 'admins' | 'ruoli'
  // Ruoli personalizzati (da configurazioni DB)
  const [ruoliCustom,    setRuoliCustom]    = useState([])
  const [loadingRuoli,   setLoadingRuoli]   = useState(true)
  const [editRuolo,      setEditRuolo]      = useState(null) // null | { id, label, color, permessi[] }
  const [nuovoRuolo,     setNuovoRuolo]     = useState({ label: '', color: '#3498db', permessi: [] })
  const [savingRuolo,    setSavingRuolo]    = useState(false)
  const isSuperAdmin = user.ruolo === 'superadmin'

  const SEZIONI_DISPONIBILI = [
    { id: 'eventi',              label: '🎪 Gestione eventi (tutto)',    gruppo: 'eventi' },
    { id: 'eventi.iscritti',     label: '  └ 📋 Iscritti',               gruppo: 'eventi' },
    { id: 'eventi.appello',      label: '  └ 🗓️ Appello giornaliero',     gruppo: 'eventi' },
    { id: 'eventi.buoni',        label: '  └ 🎟️ Buoni pasto',             gruppo: 'eventi' },
    { id: 'eventi.report',       label: '  └ 📊 Report e Spese',          gruppo: 'eventi' },
    { id: 'eventi.spese',        label: '  └ 📤 Spese',                    gruppo: 'eventi' },
    { id: 'eventi.comunicazioni',label: '  └ 📣 Comunicazioni',           gruppo: 'eventi' },
    { id: 'eventi.mail',         label: '  └ 📧 Mail',                    gruppo: 'eventi' },
    { id: 'campetto',            label: '⚽ Prenotazioni campetto' },
    { id: 'sala',                label: '🎉 Prenotazioni sala feste' },
    { id: 'feste',               label: '🥳 Gestione Feste (Tavoli)' },
    { id: 'appartamento',        label: '🏡 Prenotazioni appartamento' },
    { id: 'aule',                label: '🏫 Prenotazioni aule' },
    { id: 'admins',              label: '👥 Gestione amministratori' },
    { id: 'settings',            label: '⚙️ Impostazioni prezzi' },
  ]

  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id','ruoli_custom').maybeSingle()
      .then(({ data }) => {
        setRuoliCustom(data?.valore?.ruoli || [])
        setLoadingRuoli(false)
      })
  }, [tabAdmins])

  const salvaRuoliCustom = async (nuoviRuoli) => {
    setSavingRuolo(true)
    await supabase.from('configurazioni').upsert(
      { id: 'ruoli_custom', valore: { ruoli: nuoviRuoli } },
      { onConflict: 'id' }
    )
    setRuoliCustom(nuoviRuoli)
    setSavingRuolo(false)
  }

  const aggiungiRuolo = async () => {
    if (!nuovoRuolo.label.trim()) { alert('Inserisci un nome per il ruolo.'); return }
    const id = 'custom_' + nuovoRuolo.label.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') + '_' + Date.now()
    const lista = [...ruoliCustom, { ...nuovoRuolo, id }]
    await salvaRuoliCustom(lista)
    setNuovoRuolo({ label: '', color: '#3498db', permessi: [] })
  }

  const aggiornaRuolo = async () => {
    const lista = ruoliCustom.map(r => r.id === editRuolo.id ? editRuolo : r)
    await salvaRuoliCustom(lista)
    setEditRuolo(null)
  }

  const eliminaRuolo = async (id) => {
    if (!window.confirm('Eliminare questo ruolo?')) return
    const lista = ruoliCustom.filter(r => r.id !== id)
    await salvaRuoliCustom(lista)
  }

  const togglePermesso = (ruoloObj, setRuoloObj, sezione) => {
    const p = ruoloObj.permessi || []
    setRuoloObj(r => ({ ...r, permessi: p.includes(sezione) ? p.filter(x => x !== sezione) : [...p, sezione] }))
  }

  if (loading) return <LoadingPage />

  const aggiungi = async () => {
    if (!newAdmin.nome || !newAdmin.email) { alert('Nome ed Email sono obbligatori.'); return }
    setSaving(true)
    
    // Metodo di "Pre-Autorizzazione": 
    // Creiamo il record nella tabella admins usando l'email come chiave temporanea.
    // L'ID sarà NULL finché l'utente non si registra ufficialmente.
    // L'SQL che ti fornirò gestirà il collegamento automatico dell'ID al primo login.
    
    const { error: insErr } = await supabase.from('admins').insert([{ 
      nome: newAdmin.nome, 
      email: newAdmin.email.toLowerCase().trim(), 
      ruolo: newAdmin.ruolo, 
      attivo: true 
    }])

    if (insErr) {
      console.error('Errore creazione admin:', insErr.message)
      alert('Errore: ' + insErr.message)
    } else {
      logAudit({ user, azione: 'PRE_AUTORIZZA_ADMIN', categoria: 'Amministratori',
        dettaglio: `Pre-autorizzato admin "${newAdmin.nome}" (${newAdmin.email}) con ruolo ${newAdmin.ruolo}`,
        meta: { nome: newAdmin.nome, email: newAdmin.email, ruolo: newAdmin.ruolo } })
      
      alert(`✅ Admin pre-autorizzato! \n\nOra chiedi a ${newAdmin.nome} di registrarsi sul sito con l'email ${newAdmin.email}. Al primo accesso diventerà automaticamente amministratore.`);
      setShowAdd(false)
      setNewAdmin({ nome: '', email: '', password: '', ruolo: 'admin_segreteria' })
      reload()
    }
    setSaving(false)
  }

  const rimuovi = async (id) => {
    if (id === user.id) { alert('Non puoi rimuovere te stesso.'); return }
    if (!window.confirm('Rimuovere questo admin?')) return
    const bersaglio = admins.find(a => a.id === id)
    await supabase.from('admins').update({ attivo: false }).eq('id', id)
    logAudit({ user, azione: 'DISATTIVA_ADMIN', categoria: 'Amministratori',
      dettaglio: `Disattivato admin "${bersaglio?.nome}" (${bersaglio?.email})`,
      meta: { target_id: id, target_nome: bersaglio?.nome, target_email: bersaglio?.email } })
    reload()
  }

  const cambiaRuolo = async (id, ruolo) => {
    const bersaglio = admins.find(a => a.id === id)
    await supabase.from('admins').update({ ruolo }).eq('id', id)
    logAudit({ user, azione: 'CAMBIA_RUOLO_ADMIN', categoria: 'Amministratori',
      dettaglio: `Ruolo di "${bersaglio?.nome}" cambiato in "${ruolo}"`,
      meta: { target_id: id, target_nome: bersaglio?.nome, nuovo_ruolo: ruolo } })
    reload()
  }

  const salvaPassword = async () => {
    if (!changePwd.password || changePwd.password.length < 6) { alert('La password deve essere di almeno 6 caratteri.'); return }
    await supabase.from('admins').update({ password: changePwd.password }).eq('id', changePwd.id)
    logAudit({ user, azione: 'CAMBIA_PASSWORD_ADMIN', categoria: 'Amministratori',
      dettaglio: `Password cambiata per "${changePwd.nome}"`,
      meta: { target_id: changePwd.id, target_nome: changePwd.nome } })
    setChangePwd(null)
    reload()
  }

  // Tutti i ruoli disponibili (fissi + custom da DB)
  const tuttiRuoli = {
    ...RUOLI,
    ...Object.fromEntries(ruoliCustom.map(r => [r.id, { label: r.label, color: r.color, permessi: r.permessi }]))
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }} onClick={goBack}>← Dashboard</button>
      {!isSuperAdmin && <div className="alert alert-warn">Solo il Super Admin può gestire gli amministratori e i ruoli.</div>}

      {/* Tab amministratori / ruoli */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <div className={`tab ${tabAdmins === 'admins' ? 'active' : ''}`} onClick={() => setTabAdmins('admins')}>👥 Amministratori</div>
        {isSuperAdmin && <div className={`tab ${tabAdmins === 'ruoli' ? 'active' : ''}`} onClick={() => setTabAdmins('ruoli')}>🎭 Ruoli e permessi</div>}
      </div>

      {/* ── TAB RUOLI ── */}
      {tabAdmins === 'ruoli' && (
        <div>
          <div className="alert alert-info" style={{ marginBottom: 16, fontSize: '.85rem' }}>
            Crea ruoli personalizzati con i permessi che vuoi. I ruoli di sistema (Super Admin, Admin di default) non sono modificabili. I ruoli personalizzati appariranno nel menu di assegnazione degli admin.
          </div>

          {/* Ruoli di sistema — sola lettura */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 12, color: 'var(--primary)' }}>🔒 Ruoli di sistema (non modificabili)</div>
            {Object.entries(RUOLI).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="badge" style={{ background: v.color, color: '#fff' }}>{v.label}</span>
                <span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>ID: {k}</span>
              </div>
            ))}
          </div>

          {/* Ruoli custom */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 12, color: 'var(--primary)' }}>✏️ Ruoli personalizzati ({ruoliCustom.length})</div>
            {loadingRuoli ? <LoadingPage text="Caricamento..." /> : ruoliCustom.length === 0
              ? <div className="alert alert-info">Nessun ruolo personalizzato. Creane uno qui sotto.</div>
              : ruoliCustom.map(r => (
                <div key={r.id} style={{ border: '1.5px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                  {editRuolo?.id === r.id ? (
                    <div>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                        <input className="form-input" style={{ flex: 1 }} value={editRuolo.label}
                          onChange={e => setEditRuolo(p => ({ ...p, label: e.target.value }))} placeholder="Nome ruolo" />
                        <input type="color" value={editRuolo.color}
                          onChange={e => setEditRuolo(p => ({ ...p, color: e.target.value }))}
                          style={{ width: 44, height: 42, border: 'none', borderRadius: 8, cursor: 'pointer' }} />
                      </div>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: '.85rem', marginBottom: 6 }}>Permessi:</div>
                        {SEZIONI_DISPONIBILI.map(s => (
                          <label key={s.id} className={`check-item ${(editRuolo.permessi||[]).includes(s.id) ? 'checked' : ''}`} style={{ marginBottom: 4 }}>
                            <input type="checkbox" checked={(editRuolo.permessi||[]).includes(s.id)}
                              onChange={() => togglePermesso(editRuolo, setEditRuolo, s.id)} />
                            <span style={{ fontSize: '.85rem' }}>{s.label}</span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditRuolo(null)}>Annulla</button>
                        <button className="btn btn-primary btn-sm" onClick={aggiornaRuolo} disabled={savingRuolo}>💾 Salva</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span className="badge" style={{ background: r.color, color: '#fff', marginRight: 10 }}>{r.label}</span>
                        <small style={{ color: 'var(--text-muted)' }}>{(r.permessi||[]).length} permessi · {r.permessi?.map(p => SEZIONI_DISPONIBILI.find(s=>s.id===p)?.label?.split(' ')[0]).join(', ') || 'nessuno'}</small>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditRuolo({ ...r })}>✏️ Modifica</button>
                        <button className="btn btn-sm btn-danger" onClick={() => eliminaRuolo(r.id)}>🗑️</button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            }
          </div>

          {/* Crea nuovo ruolo */}
          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 14, color: 'var(--primary)' }}>+ Crea nuovo ruolo</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input className="form-input" style={{ flex: 1 }} value={nuovoRuolo.label}
                onChange={e => setNuovoRuolo(p => ({ ...p, label: e.target.value }))}
                placeholder="Nome ruolo (es. Animatore, Cassiere...)" />
              <input type="color" value={nuovoRuolo.color}
                onChange={e => setNuovoRuolo(p => ({ ...p, color: e.target.value }))}
                style={{ width: 44, height: 42, border: 'none', borderRadius: 8, cursor: 'pointer' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: '.85rem', marginBottom: 8 }}>Permessi da assegnare:</div>
              {SEZIONI_DISPONIBILI.map(s => (
                <label key={s.id} className={`check-item ${(nuovoRuolo.permessi||[]).includes(s.id) ? 'checked' : ''}`} style={{ marginBottom: 4 }}>
                  <input type="checkbox" checked={(nuovoRuolo.permessi||[]).includes(s.id)}
                    onChange={() => togglePermesso(nuovoRuolo, setNuovoRuolo, s.id)} />
                  <span style={{ fontSize: '.85rem' }}>{s.label}</span>
                </label>
              ))}
            </div>
            <button className="btn btn-primary" onClick={aggiungiRuolo} disabled={savingRuolo}>
              {savingRuolo ? <><span className="spinner" /> Salvataggio...</> : '+ Crea ruolo'}
            </button>
          </div>
        </div>
      )}

      {/* ── TAB AMMINISTRATORI ── */}
      {tabAdmins === 'admins' && <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
          {isSuperAdmin && <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Aggiungi admin</button>}
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>👥 Amministratori ({admins.length})</div>
        <div className="table-wrap"><table>
          <thead><tr><th>Nome</th><th>Email</th><th>Ruolo</th><th>Password</th><th></th></tr></thead>
          <tbody>{admins.map(a => (
            <tr key={a.id}>
              <td><b>{a.nome}</b> {a.id === user.id && <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 999, background: 'var(--primary-pale)', color: 'var(--primary)' }}>Tu</span>}</td>
              <td>{a.email}</td>
              <td>
                {isSuperAdmin && a.id !== user.id
                  ? <select className="form-select" style={{ width: 'auto', padding: '6px 10px' }} value={a.ruolo} onChange={e => cambiaRuolo(a.id, e.target.value)}>
                      {Object.entries(tuttiRuoli).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  : <span className="badge" style={{ background: tuttiRuoli[a.ruolo]?.color || '#666', color: '#fff' }}>{tuttiRuoli[a.ruolo]?.label || a.ruolo}</span>
                }
              </td>
              <td><button className="btn btn-sm btn-ghost" onClick={() => setChangePwd({ id: a.id, nome: a.nome, password: '' })}>🔑 Cambia</button></td>
              <td>{isSuperAdmin && a.id !== user.id && <button className="btn btn-sm btn-danger" onClick={() => rimuovi(a.id)}>🗑️</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>

      {/* Modale aggiungi */}
      {showAdd && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="modal">
            <div className="modal-title">+ Aggiungi amministratore</div>
            <div className="form-group"><label className="form-label">Nome completo *</label><input className="form-input" value={newAdmin.nome} onChange={e => setNewAdmin(p => ({ ...p, nome: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Email *</label><input className="form-input" type="email" value={newAdmin.email} onChange={e => setNewAdmin(p => ({ ...p, email: e.target.value }))} /></div>
            <div className="form-group">
              <label className="form-label">Password *</label>
              <input className="form-input" type="password" value={newAdmin.password} onChange={e => setNewAdmin(p => ({ ...p, password: e.target.value }))} placeholder="Minimo 6 caratteri" />
              <div className="form-hint">L'admin userà questa password per accedere al gestionale.</div>
            </div>
            <div className="form-group"><label className="form-label">Ruolo</label>
              <select className="form-select" value={newAdmin.ruolo} onChange={e => setNewAdmin(p => ({ ...p, ruolo: e.target.value }))}>
                {Object.entries(tuttiRuoli).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="alert alert-info">L'admin accederà con email + password dalla schermata "Area amministratori".</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={aggiungi} disabled={saving}>{saving ? <><span className="spinner" /> Aggiunta...</> : '✅ Aggiungi'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale cambia password */}
      {changePwd && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setChangePwd(null)}>
          <div className="modal">
            <div className="modal-title">🔑 Cambia password — {changePwd.nome}</div>
            <div className="form-group">
              <label className="form-label">Nuova password *</label>
              <input className="form-input" type="password" autoFocus value={changePwd.password}
                onChange={e => setChangePwd(p => ({ ...p, password: e.target.value }))} placeholder="Minimo 6 caratteri" />
            </div>
            <div className="alert alert-warn">Comunica la nuova password all'amministratore direttamente.</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setChangePwd(null)}>Annulla</button>
              <button className="btn btn-primary" onClick={salvaPassword}>💾 Salva nuova password</button>
            </div>
          </div>
        </div>
      )}
      </>}
    </div>
  )
}

// ─── CALENDARIO ───────────────────────────────────────────────────────────────
function Calendario({ prenotazioni }) {
  const [cur, setCur] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() } })
  const { y, m } = cur
  const firstDay    = new Date(y, m, 1).getDay()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const dayNames    = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']
  const monthNames  = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']
  
  // Raggruppa prenotazioni per data
  const bookedByDate = {}
  prenotazioni.forEach(p => {
    if (p.data) {
      if (!bookedByDate[p.data]) bookedByDate[p.data] = []
      bookedByDate[p.data].push(p)
    }
  })
  const todayStr    = today()

  return (
    <div>
      <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setCur(c => { const d = new Date(c.y, c.m - 1); return { y: d.getFullYear(), m: d.getMonth() } })}>‹</button>
        <h3 style={{ fontWeight: 800, color: 'var(--primary)' }}>{monthNames[m]} {y}</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setCur(c => { const d = new Date(c.y, c.m + 1); return { y: d.getFullYear(), m: d.getMonth() } })}>›</button>
      </div>
      <div className="cal-header">{dayNames.map(d => <div key={d} className="cal-day-name">{d}</div>)}</div>
      <div className="cal-grid">
        {Array(firstDay).fill(null).map((_, i) => <div key={'e' + i} />)}
        {Array(daysInMonth).fill(null).map((_, i) => {
          const day     = i + 1
          const dateStr = `${y}-${String(m + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
          const bookings = bookedByDate[dateStr] || []
          return (
            <div key={day} className={`cal-day ${bookings.length > 0 ? 'booked' : ''} ${dateStr === todayStr ? 'today' : ''}`}
                 title={bookings.map(b => `${b.ora || b.ora_inizio || ''} ${b.nome || b.chi || b.nome_referente || ''}`).join('\n')}>
              <div className="cal-day-num">{day}</div>
              {bookings.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginTop: 2 }}>
                {bookings.map((_, idx) => <div key={idx} className="cal-dot" />)}
              </div>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 16, fontSize: '.8rem', color: 'var(--text-muted)' }}>
        <span>🔴 Prenotato</span><span>🟡 Oggi</span>
      </div>
      </div>
    </div>
  )
}


// ─── DATE BLOCCATE ────────────────────────────────────────────────────────────
function DateBloccateAdmin({ user }) {
  const [dateBloccate, setDateBloccate] = useState([])
  const [loading,      setLoading]      = useState(true)
  const [nuovaData,    setNuovaData]    = useState('')
  const [nuovoMotivo,  setNuovoMotivo]  = useState('')
  const [saving,       setSaving]       = useState(false)

  const carica = async () => {
    setLoading(true)
    const { data } = await supabase.from('configurazioni')
      .select('valore').eq('id', 'date_bloccate').maybeSingle()
    setDateBloccate(data?.valore?.date || [])
    setLoading(false)
  }

  useEffect(() => { carica() }, [])

  const salva = async (nuoveListe) => {
    await supabase.from('configurazioni').upsert(
      { id: 'date_bloccate', valore: { date: nuoveListe } },
      { onConflict: 'id' }
    )
    logAudit({ user, azione: 'MODIFICA_DATE_BLOCCATE', categoria: 'Impostazioni',
      dettaglio: `Aggiornate date bloccate (${nuoveListe.length} date)` })
  }

  const aggiungi = async () => {
    if (!nuovaData) { alert('Seleziona una data.'); return }
    if (dateBloccate.some(d => d.data === nuovaData)) { alert('Questa data è già bloccata.'); return }
    setSaving(true)
    const nuove = [...dateBloccate, { data: nuovaData, motivo: nuovoMotivo || 'Chiuso' }]
      .sort((a, b) => a.data.localeCompare(b.data))
    await salva(nuove)
    setDateBloccate(nuove)
    setNuovaData(''); setNuovoMotivo('')
    setSaving(false)
  }

  const rimuovi = async (data) => {
    const nuove = dateBloccate.filter(d => d.data !== data)
    await salva(nuove)
    setDateBloccate(nuove)
  }

  // Aggiunta rapida: blocca un intero range
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd,   setRangeEnd]   = useState('')
  const [rangeMotivo, setRangeMotivo] = useState('')
  const [savingRange, setSavingRange] = useState(false)

  const aggiungiRange = async () => {
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      alert('Seleziona un range di date valido.'); return
    }
    setSavingRange(true)
    const days = []
    let cur = new Date(rangeStart + 'T12:00:00')
    const end = new Date(rangeEnd + 'T12:00:00')
    while (cur <= end) {
      days.push(cur.toISOString().split('T')[0])
      cur.setDate(cur.getDate() + 1)
    }
    const esistenti = new Set(dateBloccate.map(d => d.data))
    const nuoveDaAggiungere = days.filter(d => !esistenti.has(d))
      .map(d => ({ data: d, motivo: rangeMotivo || 'Chiuso' }))
    const nuove = [...dateBloccate, ...nuoveDaAggiungere]
      .sort((a, b) => a.data.localeCompare(b.data))
    await salva(nuove)
    setDateBloccate(nuove)
    setRangeStart(''); setRangeEnd(''); setRangeMotivo('')
    setSavingRange(false)
  }

  if (loading) return <LoadingPage text="Caricamento..." />

  return (
    <div>
      {/* Aggiungi singola data */}
      <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: '.88rem', marginBottom: 10 }}>➕ Blocca singola data</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: '.78rem' }}>Data</label>
            <input className="form-input" type="date" value={nuovaData}
              onChange={e => setNuovaData(e.target.value)} style={{ padding: '7px 10px' }} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label" style={{ fontSize: '.78rem' }}>Motivo (es. Grest)</label>
            <input className="form-input" value={nuovoMotivo} placeholder="Chiuso"
              onChange={e => setNuovoMotivo(e.target.value)} style={{ padding: '7px 10px' }} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={aggiungi} disabled={saving}>
            {saving ? <span className="spinner" /> : '+ Aggiungi'}
          </button>
        </div>
      </div>

      {/* Aggiungi range */}
      <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: '.88rem', marginBottom: 10 }}>📅 Blocca periodo (es. Grest)</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: '.78rem' }}>Dal</label>
            <input className="form-input" type="date" value={rangeStart}
              onChange={e => setRangeStart(e.target.value)} style={{ padding: '7px 10px' }} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ fontSize: '.78rem' }}>Al</label>
            <input className="form-input" type="date" value={rangeEnd}
              onChange={e => setRangeEnd(e.target.value)} style={{ padding: '7px 10px' }} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label" style={{ fontSize: '.78rem' }}>Motivo</label>
            <input className="form-input" value={rangeMotivo} placeholder="Grest 2026"
              onChange={e => setRangeMotivo(e.target.value)} style={{ padding: '7px 10px' }} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={aggiungiRange} disabled={savingRange}>
            {savingRange ? <span className="spinner" /> : '📅 Blocca periodo'}
          </button>
        </div>
      </div>

      {/* Lista date bloccate */}
      {dateBloccate.length === 0
        ? <div className="alert alert-info">Nessuna data bloccata. I form pubblici sono sempre disponibili.</div>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Data</th><th>Giorno</th><th>Motivo</th><th></th></tr></thead>
              <tbody>
                {dateBloccate.map(d => (
                  <tr key={d.data}>
                    <td style={{ fontWeight: 700 }}>{d.data}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>
                      {new Date(d.data + 'T12:00:00').toLocaleDateString('it', { weekday: 'long' })}
                    </td>
                    <td>
                      <span style={{ background: 'var(--primary-pale)', color: 'var(--primary)',
                        borderRadius: 20, padding: '2px 10px', fontSize: '.8rem', fontWeight: 700 }}>
                        🚫 {d.motivo}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }}
                        onClick={() => rimuovi(d.data)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  )
}

// Hook per controllare se una data è bloccata (usato nei form pubblici)
function useDateBloccate() {
  const [dateBloccate, setDateBloccate] = useState([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    supabase.from('configurazioni').select('valore').eq('id', 'date_bloccate').maybeSingle()
      .then(({ data }) => {
        setDateBloccate((data?.valore?.date || []).map(d => d.data))
        setLoaded(true)
      })
  }, [])
  const isBloccata = (data) => dateBloccate.includes(data)
  const motivoBloccata = (data) => {
    // ricarica dal DB per avere il motivo
    return 'questa data'
  }
  return { dateBloccate, isBloccata, loaded }
}

// ─── ADMIN SETTINGS ──────────────────────────────────────────────────────────
function AdminSettings({ user, goBack }) {
  const isSuperAdmin = user.ruolo === 'superadmin'
  const { data: cfg, reload } = useSupabaseData('configurazioni', {})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  // Prezzi campetto
  const campettoCfg = cfg?.find?.(c => c.id === 'campetto')?.valore || {}
  const salaCfg     = cfg?.find?.(c => c.id === 'sala')?.valore     || {}

  const [campPrezzi, setCampPrezzi] = useState(null)
  const [salaPrezzi, setSalaPrezzi] = useState(null)

  useEffect(() => {
    if (campettoCfg.prezzi && !campPrezzi) setCampPrezzi(campettoCfg.prezzi)
    if (salaCfg.prezzi     && !salaPrezzi) setSalaPrezzi(salaCfg.prezzi)
  }, [cfg])

  const salvaCampetto = async () => {
    setSaving(true)
    await supabase.from('configurazioni').update({ valore: { ...campettoCfg, prezzi: campPrezzi } }).eq('id', 'campetto')
    logAudit({ user, azione: 'MODIFICA_PREZZI_CAMPETTO', categoria: 'Impostazioni',
      dettaglio: 'Aggiornati prezzi campetto', meta: campPrezzi })
    setSaving(false); setMsg('✅ Prezzi campetto salvati!'); reload()
    setTimeout(() => setMsg(''), 3000)
  }

  const salvaSala = async () => {
    setSaving(true)
    await supabase.from('configurazioni').update({ valore: { ...salaCfg, prezzi: salaPrezzi } }).eq('id', 'sala')
    logAudit({ user, azione: 'MODIFICA_PREZZI_SALA', categoria: 'Impostazioni',
      dettaglio: 'Aggiornati prezzi sala feste', meta: salaPrezzi })
    setSaving(false); setMsg('✅ Prezzi sala salvati!'); reload()
    setTimeout(() => setMsg(''), 3000)
  }

  const setPc = (k, v) => setCampPrezzi(p => ({ ...p, [k]: +v }))
  const setSp = (k, v) => setSalaPrezzi(p => ({ ...p, [k]: +v }))

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }} onClick={goBack}>← Dashboard</button>
      <h2 style={{ fontWeight: 900, color: 'var(--primary)', marginBottom: 20 }}>⚙️ Impostazioni</h2>

      {msg && <div className="alert alert-success" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Prezzi campetto */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 16, color: 'var(--primary)' }}>⚽ Prezzi Campetto</div>
        {campPrezzi && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {Object.entries(campPrezzi).map(([k, v]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{k.replace(/_/g, ' ')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input className="form-input" type="number" value={v} onChange={e => setPc(k, e.target.value)} />
                  <span style={{ color: 'var(--text-muted)' }}>€</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-primary" onClick={salvaCampetto} disabled={saving || !campPrezzi} style={{ marginTop: 12 }}>
          💾 Salva prezzi campetto
        </button>
      </div>

      {/* Prezzi sala feste */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 16, color: 'var(--primary)' }}>🎉 Prezzi Sala Feste</div>
        {salaPrezzi && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {Object.entries(salaPrezzi).map(([k, v]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{k.replace(/_/g, ' ')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input className="form-input" type="number" value={v} onChange={e => setSp(k, e.target.value)} />
                  <span style={{ color: 'var(--text-muted)' }}>€</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-primary" onClick={salvaSala} disabled={saving || !salaPrezzi} style={{ marginTop: 12 }}>
          💾 Salva prezzi sala
        </button>
      </div>

      {/* ── DATE BLOCCATE ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 8, color: 'var(--primary)' }}>
          🚫 Date bloccate prenotazioni
        </div>
        <div style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 16 }}>
          Nelle date qui indicate, i form pubblici di campetto, sala feste e aule mostreranno un messaggio
          di chiusura (es. durante il Grest, feste patronali, ecc.)
        </div>
        <DateBloccateAdmin user={user} />
      </div>

      {/* ── NOTIFICHE ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', marginBottom: 8, color: 'var(--primary)' }}>
          🔔 Notifiche su questo dispositivo
        </div>
        <div style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 16 }}>
          Attiva le notifiche per ricevere aggiornamenti su prenotazioni e appello.
          <br />
          <b>PC:</b> Arriveranno solo quando sei loggato.
          <br />
          <b>Telefono:</b> Arriveranno sempre, anche se l'app è chiusa.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ 
            width: 12, height: 12, borderRadius: '50%', 
            backgroundColor: Notification.permission === 'granted' ? '#4caf50' : '#f44336' 
          }} />
          <span style={{ fontSize: '.9rem', fontWeight: 600 }}>
            Stato: {Notification.permission === 'granted' ? 'Attive' : 'Non attive'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            const sub = await initWebPush(user.id, user.ruolo === 'superadmin' ? 'superadmin' : 'admin')
            if (sub) {
              setMsg('✅ Notifiche attivate con successo!')
              reload()
            } else {
              alert('Impossibile attivare le notifiche. Controlla i permessi del browser.')
            }
          }}>
            {Notification.permission === 'granted' ? '🔄 Aggiorna sottoscrizione' : '🔔 Attiva ora'}
          </button>
        </div>
      </div>

      {!isSuperAdmin && (
        <div className="alert alert-info">Solo il superadmin può modificare le impostazioni avanzate.</div>
      )}
    </div>
  )
}

// ─── ECONOMIA E BILANCIO ──────────────────────────────────────────────────────
function AdminEconomia({ user, goBack }) {
  const [tab, setTab] = useState('dashboard')
  const [movimenti, setMovimenti] = useState([])
  const [categorie, setCategorie] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [currentMov, setCurrentMov] = useState(null)
  
  // Filtri
  const [filtroMese, setFiltroMese] = useState(new Date().toISOString().slice(0, 7)) // YYYY-MM
  const [filtroTipo, setFiltroTipo] = useState('tutti')

  const caricaDati = useCallback(async () => {
    setLoading(true)
    try {
      const { data: cat } = await supabase.from('economia_categorie').select('*').eq('attivo', true)
      setCategorie(cat || [])

      let query = supabase.from('economia_movimenti').select('*, economia_categorie(*)').order('data', { ascending: false })
      
      if (filtroMese) {
        const [year, month] = filtroMese.split('-')
        const firstDay = `${filtroMese}-01`
        // Calcola l'ultimo giorno del mese in modo dinamico
        const lastDayDate = new Date(parseInt(year), parseInt(month), 0)
        const lastDay = `${filtroMese}-${String(lastDayDate.getDate()).padStart(2, '0')}`
        query = query.gte('data', firstDay).lte('data', lastDay)
      }
      
      if (filtroTipo !== 'tutti') {
        query = query.eq('tipo', filtroTipo)
      }

      const { data: mov } = await query
      setMovimenti(mov || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [filtroMese, filtroTipo])

  useEffect(() => { caricaDati() }, [caricaDati])

  const salvaMovimento = async (e) => {
    e.preventDefault()
    const form = e.target
    const data = {
      data: form.data.value,
      titolo: form.titolo.value,
      importo: parseFloat(form.importo.value),
      tipo: form.tipo.value,
      categoria_id: form.categoria_id.value || null,
      descrizione: form.descrizione.value,
      metodo_pagamento: form.metodo.value,
      creato_da: user.id
    }

    try {
      if (currentMov?.id) {
        const { error } = await supabase.from('economia_movimenti').update(data).eq('id', currentMov.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('economia_movimenti').insert([data])
        if (error) throw error
      }
      setShowModal(false)
      setCurrentMov(null)
      caricaDati()
    } catch (err) {
        console.error('Errore salvataggio:', err)
        alert('Errore nel salvataggio: ' + (err.message || 'Errore sconosciuto'))
      }
  }

  const eliminaMovimento = async (id) => {
    if (!window.confirm('Eliminare questo movimento?')) return
    const { error } = await supabase.from('economia_movimenti').delete().eq('id', id)
    if (error) {
      alert('Errore nell\'eliminazione: ' + error.message)
    } else {
      caricaDati()
    }
  }

  // Calcoli Dashboard
  const entrate = movimenti.filter(m => m.tipo === 'entrata').reduce((s, m) => s + m.importo, 0)
  const uscite = movimenti.filter(m => m.tipo === 'uscita').reduce((s, m) => s + m.importo, 0)
  const bilancio = entrate - uscite

  return (
    <div className="admin-economia">
      <div className="tabs">
        <button className={`tab ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>📊 Dashboard</button>
        <button className={`tab ${tab === 'registro' ? 'active' : ''}`} onClick={() => setTab('registro')}>📝 Registro Movimenti</button>
        <button className={`tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>📈 Report Annuale</button>
      </div>

      {tab === 'dashboard' && (
        <div className="fade-in">
          <div className="grid-3" style={{ marginBottom: 24 }}>
            <div className="stat-card" style={{ borderLeft: '5px solid var(--green)' }}>
              <div className="stat-label">Entrate del Mese</div>
              <div className="stat-value" style={{ color: 'var(--green)' }}>{fmt(entrate)}</div>
              <div className="stat-icon">📈</div>
            </div>
            <div className="stat-card" style={{ borderLeft: '5px solid var(--danger)' }}>
              <div className="stat-label">Uscite del Mese</div>
              <div className="stat-value" style={{ color: 'var(--danger)' }}>{fmt(uscite)}</div>
              <div className="stat-icon">📉</div>
            </div>
            <div className="stat-card" style={{ borderLeft: '5px solid var(--primary)' }}>
              <div className="stat-label">Bilancio Mensile</div>
              <div className="stat-value" style={{ color: bilancio >= 0 ? 'var(--green)' : 'var(--danger)' }}>{fmt(bilancio)}</div>
              <div className="stat-icon">⚖️</div>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-header"><h3 className="card-title">Entrate per Categoria</h3></div>
              {categorie.filter(c => c.tipo === 'entrata').map(c => {
                const tot = movimenti.filter(m => m.categoria_id === c.id).reduce((s, m) => s + m.importo, 0)
                if (tot === 0) return null
                return (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
                    <span>{c.icona} {c.nome}</span>
                    <span style={{ fontWeight: 700 }}>{fmt(tot)}</span>
                  </div>
                )
              })}
            </div>
            <div className="card">
              <div className="card-header"><h3 className="card-title">Uscite per Categoria</h3></div>
              {categorie.filter(c => c.tipo === 'uscita').map(c => {
                const tot = movimenti.filter(m => m.categoria_id === c.id).reduce((s, m) => s + m.importo, 0)
                if (tot === 0) return null
                return (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
                    <span>{c.icona} {c.nome}</span>
                    <span style={{ fontWeight: 700 }}>{fmt(tot)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'registro' && (
        <div className="card fade-in">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
            <h3 className="card-title">Registro Contabile</h3>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input type="month" className="form-input" style={{ width: 160 }} value={filtroMese} onChange={e => setFiltroMese(e.target.value)} />
              <select className="form-select" style={{ width: 120 }} value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
                <option value="tutti">Tutti</option>
                <option value="entrata">Entrate</option>
                <option value="uscita">Uscite</option>
              </select>
              <button className="btn btn-primary" onClick={() => { setCurrentMov(null); setShowModal(true) }}>➕ Nuovo</button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Titolo / Categoria</th>
                  <th>Metodo</th>
                  <th>Importo</th>
                  <th style={{ textAlign: 'right' }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {movimenti.length === 0 ? (
                  <tr><td colSpan="5" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Nessun movimento trovato per questo periodo.</td></tr>
                ) : movimenti.map(m => (
                  <tr key={m.id}>
                    <td style={{ fontSize: '.8rem' }}>{new Date(m.data).toLocaleDateString('it-IT')}</td>
                    <td>
                      <div style={{ fontWeight: 700 }}>{m.titolo}</div>
                      <div style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>{m.economia_categorie?.icona} {m.economia_categorie?.nome || 'Senza categoria'}</div>
                    </td>
                    <td><span className="badge" style={{ background: '#eee', color: '#666' }}>{m.metodo_pagamento}</span></td>
                    <td style={{ fontWeight: 800, color: m.tipo === 'entrata' ? 'var(--green)' : 'var(--danger)' }}>
                      {m.tipo === 'entrata' ? '+' : '-'} {fmt(m.importo)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => { setCurrentMov(m); setShowModal(true) }}>✏️</button>
                      <button className="btn btn-sm btn-ghost" style={{ marginLeft: 5 }} onClick={() => eliminaMovimento(m.id)}>🗑️</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'report' && (
        <div className="card fade-in" style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: '3rem', marginBottom: 20 }}>📊</div>
          <h3>Report Annuale in arrivo</h3>
          <p style={{ color: 'var(--text-muted)' }}>Stiamo elaborando i grafici per il bilancio annuale consolidato.</p>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 500 }}>
            <h3 className="modal-title">{currentMov ? 'Modifica Movimento' : 'Nuovo Movimento'}</h3>
            <form onSubmit={salvaMovimento}>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Data</label>
                  <input className="form-input" type="date" name="data" defaultValue={currentMov?.data || today()} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Tipo</label>
                  <select className="form-select" name="tipo" defaultValue={currentMov?.tipo || 'entrata'} required>
                    <option value="entrata">Entrata (+)</option>
                    <option value="uscita">Uscita (-)</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Titolo</label>
                <input className="form-input" name="titolo" placeholder="Es: Spesa bar, Offerta..." defaultValue={currentMov?.titolo || ''} required />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Importo (€)</label>
                  <input className="form-input" type="number" step="0.01" name="importo" defaultValue={currentMov?.importo || ''} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Categoria</label>
                  <select className="form-select" name="categoria_id" defaultValue={currentMov?.categoria_id || ''}>
                    <option value="">Senza categoria</option>
                    {categorie.map(c => <option key={c.id} value={c.id}>{c.icona} {c.nome} ({c.tipo})</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Metodo Pagamento</label>
                  <select className="form-select" name="metodo" defaultValue={currentMov?.metodo_pagamento || 'contanti'}>
                    <option value="contanti">Contanti</option>
                    <option value="bonifico">Bonifico</option>
                    <option value="carta">Carta / POS</option>
                    <option value="altro">Altro</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Descrizione (opzionale)</label>
                <textarea className="form-textarea" name="descrizione" defaultValue={currentMov?.descrizione || ''}></textarea>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Annulla</button>
                <button type="submit" className="btn btn-primary">💾 Salva</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
