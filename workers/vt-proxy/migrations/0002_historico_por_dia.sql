-- Historico guarda so o dia (AAAA-MM-DD), nao o horario. Converte as linhas antigas.
UPDATE consultas SET em = substr(em, 1, 10) WHERE length(em) > 10;
