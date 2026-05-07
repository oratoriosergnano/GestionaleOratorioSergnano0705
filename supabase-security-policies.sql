-- ============================================================
-- NUOVE POLITICHE DI SICUREZZA (RLS) - ORATORIO DI SERGNANO
-- ============================================================
-- Esegui questo script nel SQL Editor di Supabase per mettere in sicurezza il database.

-- 1. Reset delle politiche esistenti
DO $$ 
DECLARE 
    r RECORD;
BEGIN
    FOR r IN (SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public') 
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(r.policyname) || ' ON ' || quote_ident(r.tablename);
    END LOOP;
END $$;

-- 2. Funzione di utilità per verificare se l'utente è un admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admins 
    WHERE id = auth.uid() AND attivo = TRUE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. ADMINS: Solo gli admin possono vedere/modificare altri admin
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_admins" ON admins FOR ALL TO authenticated USING (public.is_admin());

-- 4. EVENTI: Pubblico vede solo attivi, Admin tutto
ALTER TABLE eventi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_read_eventi" ON eventi FOR SELECT TO public USING (attivo = TRUE);
CREATE POLICY "admin_all_eventi" ON eventi FOR ALL TO authenticated USING (public.is_admin());

-- 5. ISCRIZIONI: Pubblico può inserire, Genitori vedono solo la propria (tramite codice), Admin tutto
ALTER TABLE iscrizioni ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_insert_iscrizioni" ON iscrizioni FOR INSERT TO public WITH CHECK (TRUE);
CREATE POLICY "parent_read_own_iscrizione" ON iscrizioni FOR SELECT TO public USING (TRUE); -- Limitato dall'app tramite codice_accesso
CREATE POLICY "admin_all_iscrizioni" ON iscrizioni FOR ALL TO authenticated USING (public.is_admin());

-- 6. PRENOTAZIONI (Campetto, Sala, Appartamento, Aule): Pubblico inserisce, Admin gestisce
ALTER TABLE prenotazioni_campetto ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_insert_campetto" ON prenotazioni_campetto FOR INSERT TO public WITH CHECK (TRUE);
CREATE POLICY "admin_all_campetto" ON prenotazioni_campetto FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE prenotazioni_sala ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_insert_sala" ON prenotazioni_sala FOR INSERT TO public WITH CHECK (TRUE);
CREATE POLICY "admin_all_sala" ON prenotazioni_sala FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE prenotazioni_appartamento ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_insert_appartamento" ON prenotazioni_appartamento FOR INSERT TO public WITH CHECK (TRUE);
CREATE POLICY "admin_all_appartamento" ON prenotazioni_appartamento FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE prenotazioni_aule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_insert_aule" ON prenotazioni_aule FOR INSERT TO public WITH CHECK (TRUE);
CREATE POLICY "admin_all_aule" ON prenotazioni_aule FOR ALL TO authenticated USING (public.is_admin());

-- 7. CONFIGURAZIONI: Pubblico legge, Admin tutto
ALTER TABLE configurazioni ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub_read_config" ON configurazioni FOR SELECT TO public USING (TRUE);
CREATE POLICY "admin_all_config" ON configurazioni FOR ALL TO authenticated USING (public.is_admin());

-- 8. ALTRE TABELLE (Presenze, Appello, Buoni, Log, Notifiche, Comunicazioni): Solo Admin
ALTER TABLE presenze ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_presenze" ON presenze FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE appello_giornaliero ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_appello" ON appello_giornaliero FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE buoni_pasto ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_buoni" ON buoni_pasto FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE log_pagamenti_buoni ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_logpag" ON log_pagamenti_buoni FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE notifiche_addebito ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_notifiche" ON notifiche_addebito FOR ALL TO authenticated USING (public.is_admin());

ALTER TABLE comunicazioni_inviate ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_comunicazioni" ON comunicazioni_inviate FOR ALL TO authenticated USING (public.is_admin());

-- NOTA: Ricordati di abilitare l'autenticazione tramite Supabase Auth per tutti gli admin 
-- e collegare il loro UID alla tabella public.admins.
