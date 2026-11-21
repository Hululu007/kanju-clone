-- Add measured media height without rewriting or dropping existing playback rows.
ALTER TABLE sources ADD COLUMN quality INTEGER;
