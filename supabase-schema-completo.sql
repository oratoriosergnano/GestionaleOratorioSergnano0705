-- ============================================================
-- SCHEMA COMPLETO - ORATORIO DI SERGNANO v3.5
-- Progetto nuovo: incolla tutto nella SQL Editor di Supabase
-- e clicca "Run"
--
-- NOTA: "database system is shutting down" e' un errore
-- temporaneo di Supabase. Aspetta 30-60 secondi e riprova.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABELLE PRINCIPALI
-- ============================================================

CREATE TABLE IF NOT EXISTS admins (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       TEXT        NOT NULL,
  email      TEXT        NOT NULL UNIQUE,
  ruolo      TEXT        NOT NULL DEFAULT 'admin_segreteria',
  password   TEXT        NOT NULL DEFAULT 'cambiami123',
  attivo     BOOLEAN     DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO admins (nome, email, ruolo, password)
VALUES ('Giovanni Triassi', 'giovannitriassi55@gmail.com', 'superadmin', 'oratorio2026')
ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS eventi (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               TEXT          NOT NULL,
  descrizione        TEXT,
  data_inizio        DATE          NOT NULL,
  data_fine          DATE          NOT NULL,
  quota_base         NUMERIC(10,2) DEFAULT 0,
  prezzo_settimana   NUMERIC(10,2) DEFAULT 0,
  prezzo_giornata    NUMERIC(10,2) DEFAULT 0,
  sconto_fratelli    NUMERIC(10,2) DEFAULT 0,
  prezzo_buono       NUMERIC(10,2) DEFAULT 3.50,
  servizi            JSONB         DEFAULT '[]',
  campi_extra        JSONB         DEFAULT '[]',
  metodi_pagamento   TEXT[]        DEFAULT ARRAY['Contanti','POS/Carta','Bonifico'],
  attivo             BOOLEAN       DEFAULT TRUE,
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS iscrizioni (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id            UUID          REFERENCES eventi(id) ON DELETE CASCADE,
  nome_bambino         TEXT          NOT NULL,
  cognome_bambino      TEXT          NOT NULL,
  data_nascita         DATE,
  comune_residenza     TEXT,
  nome_genitore        TEXT,
  cognome_genitore     TEXT,
  email_genitore       TEXT,
  telefono_genitore    TEXT,
  settimane            JSONB         DEFAULT '[]',
  servizi              JSONB         DEFAULT '[]',
  mensa_settimane      TEXT[]        DEFAULT ARRAY[]::TEXT[],
  is_fratello          BOOLEAN       DEFAULT FALSE,
  note                 TEXT,
  consenso_privacy     BOOLEAN       DEFAULT FALSE,
  consenso_foto        BOOLEAN       DEFAULT FALSE,
  consenso_regolamento BOOLEAN       DEFAULT FALSE,
  totale               NUMERIC(10,2) DEFAULT 0,
  metodo_pagamento     TEXT,
  dati_extra           JSONB         DEFAULT '{}',
  password_genitore    TEXT,
  codice_accesso       TEXT          UNIQUE,
  codice_famiglia      TEXT,
  saldato              BOOLEAN       DEFAULT FALSE,
  created_at           TIMESTAMPTZ   DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iscrizioni_codice
  ON iscrizioni(codice_accesso) WHERE codice_accesso IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_iscrizioni_famiglia
  ON iscrizioni(codice_famiglia) WHERE codice_famiglia IS NOT NULL;

CREATE TABLE IF NOT EXISTS presenze (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  iscrizione_id    UUID        REFERENCES iscrizioni(id) ON DELETE CASCADE,
  evento_id        UUID        REFERENCES eventi(id) ON DELETE CASCADE,
  data_o_settimana TEXT        NOT NULL,
  stato            TEXT        CHECK (stato IN ('P','A')) DEFAULT NULL,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(iscrizione_id, data_o_settimana)
);

CREATE TABLE IF NOT EXISTS appello_giornaliero (
  iscrizione_id UUID REFERENCES iscrizioni(id) ON DELETE CASCADE,
  evento_id     UUID REFERENCES eventi(id) ON DELETE CASCADE,
  data          DATE NOT NULL,
  presenza      TEXT CHECK (presenza IN ('P','A')),
  pranzo        TEXT CHECK (pranzo IN ('casa','sacco','mensa')),
  PRIMARY KEY (iscrizione_id, evento_id, data)
);

CREATE TABLE IF NOT EXISTS buoni_pasto (
  iscrizione_id UUID REFERENCES iscrizioni(id) ON DELETE CASCADE,
  evento_id     UUID REFERENCES eventi(id) ON DELETE CASCADE,
  quantita      INTEGER DEFAULT 0,
  PRIMARY KEY (iscrizione_id, evento_id)
);

CREATE TABLE IF NOT EXISTS log_pagamenti_buoni (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id     UUID          REFERENCES eventi(id) ON DELETE CASCADE,
  iscrizione_id UUID          REFERENCES iscrizioni(id) ON DELETE CASCADE,
  nome_bambino  TEXT,
  quantita      INTEGER,
  importo       NUMERIC(10,2),
  metodo        TEXT,
  note          TEXT,
  tipo          TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifiche_addebito (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  iscrizione_id UUID        REFERENCES iscrizioni(id) ON DELETE CASCADE,
  evento_id     UUID        REFERENCES eventi(id) ON DELETE CASCADE,
  data          DATE        NOT NULL,
  email         TEXT,
  nome_bambino  TEXT,
  letta         BOOLEAN     DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comunicazioni_inviate (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id         UUID        REFERENCES eventi(id) ON DELETE CASCADE,
  oggetto           TEXT,
  messaggio         TEXT,
  destinatari_count INTEGER,
  inviata_il        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PRENOTAZIONI SERVIZI
-- ============================================================

CREATE TABLE IF NOT EXISTS prenotazioni_campetto (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  nome             TEXT          NOT NULL,
  telefono         TEXT          NOT NULL,
  email            TEXT,
  data             DATE          NOT NULL,
  ora              TEXT          NOT NULL,
  durata           TEXT          NOT NULL,
  docce            BOOLEAN       DEFAULT FALSE,
  prezzo           NUMERIC(10,2) DEFAULT 0,
  note             TEXT,
  metodo_pagamento TEXT,
  dati_extra       JSONB         DEFAULT '{}',
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prenotazioni_sala (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  nome             TEXT          NOT NULL,
  telefono         TEXT          NOT NULL,
  email            TEXT,
  data             DATE          NOT NULL,
  riscaldamento    BOOLEAN       DEFAULT FALSE,
  campetto         BOOLEAN       DEFAULT FALSE,
  persone          INTEGER,
  prezzo           NUMERIC(10,2) DEFAULT 0,
  note             TEXT,
  metodo_pagamento TEXT,
  dati_extra       JSONB         DEFAULT '{}',
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prenotazioni_appartamento (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_gruppo      TEXT        NOT NULL,
  referente        TEXT        NOT NULL,
  email            TEXT        NOT NULL,
  telefono         TEXT,
  arrivo           DATE        NOT NULL,
  partenza         DATE        NOT NULL,
  partecipanti     INTEGER,
  note             TEXT,
  dati_extra       JSONB       DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prenotazioni_aule (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chi              TEXT        NOT NULL,
  email            TEXT,
  telefono         TEXT,
  aula             TEXT        NOT NULL,
  data             DATE        NOT NULL,
  ora_inizio       TEXT,
  ora_fine         TEXT,
  note             TEXT,
  dati_extra       JSONB       DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONFIGURAZIONI
-- ============================================================

CREATE TABLE IF NOT EXISTS configurazioni (
  id         TEXT        PRIMARY KEY,
  valore     JSONB       NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO configurazioni (id, valore) VALUES ('campetto', '{"prezzi":{"1h_no_docce":40,"1h_docce":50,"1_5h_no_docce":70,"1_5h_docce":80,"extra_h":40,"extra_docce":10},"orario_inizio":17,"orario_fine":22,"campi_extra":[],"metodi":["Contanti","POS/Carta","Bonifico"]}') ON CONFLICT (id) DO NOTHING;
INSERT INTO configurazioni (id, valore) VALUES ('sala', '{"prezzi":{"senza_riscaldamento":40,"con_riscaldamento":60,"aggiunta_campetto":20},"campi_extra":[],"metodi":["Contanti","POS/Carta","Bonifico"]}') ON CONFLICT (id) DO NOTHING;
INSERT INTO configurazioni (id, valore) VALUES ('aule', '{"aule":[],"campi_extra":[]}') ON CONFLICT (id) DO NOTHING;
INSERT INTO configurazioni (id, valore) VALUES ('appartamento', '{"campi_extra":[]}') ON CONFLICT (id) DO NOTHING;
INSERT INTO configurazioni (id, valore) VALUES ('ruoli_custom', '{"ruoli":[]}') ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE admins                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventi                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE iscrizioni                ENABLE ROW LEVEL SECURITY;
ALTER TABLE presenze                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE appello_giornaliero       ENABLE ROW LEVEL SECURITY;
ALTER TABLE buoni_pasto               ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_pagamenti_buoni       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifiche_addebito        ENABLE ROW LEVEL SECURITY;
ALTER TABLE comunicazioni_inviate     ENABLE ROW LEVEL SECURITY;
ALTER TABLE prenotazioni_campetto     ENABLE ROW LEVEL SECURITY;
ALTER TABLE prenotazioni_sala         ENABLE ROW LEVEL SECURITY;
ALTER TABLE prenotazioni_appartamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE prenotazioni_aule         ENABLE ROW LEVEL SECURITY;
ALTER TABLE configurazioni            ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pub_read_eventi"     ON eventi             FOR SELECT USING (attivo = TRUE);
CREATE POLICY "pub_read_config"     ON configurazioni     FOR SELECT USING (TRUE);
CREATE POLICY "pub_read_iscrizioni" ON iscrizioni         FOR SELECT USING (TRUE);
CREATE POLICY "pub_read_comunicaz"  ON comunicazioni_inviate FOR SELECT USING (TRUE);

CREATE POLICY "pub_insert_iscrizioni"   ON iscrizioni                FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_campetto"     ON prenotazioni_campetto     FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_sala"         ON prenotazioni_sala         FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_appartamento" ON prenotazioni_appartamento FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_aule"         ON prenotazioni_aule         FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_logpag"       ON log_pagamenti_buoni       FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "pub_insert_buoni"        ON buoni_pasto               FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "all_admins"        ON admins                    FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_eventi"        ON eventi                    FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_iscrizioni"    ON iscrizioni                FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_presenze"      ON presenze                  FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_appello"       ON appello_giornaliero       FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_buoni"         ON buoni_pasto               FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_logpag"        ON log_pagamenti_buoni       FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_notifiche"     ON notifiche_addebito        FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_comunicazioni" ON comunicazioni_inviate     FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_campetto"      ON prenotazioni_campetto     FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_sala"          ON prenotazioni_sala         FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_appartamento"  ON prenotazioni_appartamento FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_aule"          ON prenotazioni_aule         FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "all_config"        ON configurazioni            FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- DOPO L'ESECUZIONE:
-- 1. Settings -> API -> copia Project URL e anon key
-- 2. Crea .env nella cartella del progetto:
--    REACT_APP_SUPABASE_URL=https://xxxx.supabase.co
--    REACT_APP_SUPABASE_ANON_KEY=eyJ...
-- 3. npm install && npm start
-- ============================================================
