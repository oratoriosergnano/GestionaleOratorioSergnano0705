-- Tabella per i movimenti economici
CREATE TABLE IF NOT EXISTS movimenti_economici (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('entrata', 'uscita')),
  data DATE NOT NULL,
  importo NUMERIC(10, 2) NOT NULL,
  descrizione TEXT NOT NULL,
  categoria VARCHAR(100),
  giustifica TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indicizza per data per performance
CREATE INDEX IF NOT EXISTS idx_movimenti_economici_data ON movimenti_economici (data DESC);
