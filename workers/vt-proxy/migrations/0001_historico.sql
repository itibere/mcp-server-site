-- Historico das consultas do sitesecure (sem IP, sem URL completa, sem chave PIX).
CREATE TABLE IF NOT EXISTS consultas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  em TEXT NOT NULL,
  tipo TEXT NOT NULL,
  dominio TEXT,
  instituicao TEXT,
  nota TEXT NOT NULL,
  cache INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_consultas_em ON consultas (em);
CREATE INDEX IF NOT EXISTS idx_consultas_dominio ON consultas (dominio);
