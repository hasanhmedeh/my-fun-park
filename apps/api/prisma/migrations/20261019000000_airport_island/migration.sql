-- Funfair International and Palm Cay: Funfair Air's flight to the island (one round is one flight,
-- gate to gate, either way) and the four attractions of the island's beach park, the jet-ski race,
-- the water-slide tower, the pirate cannons and beach volley. Each takes tickets like every other
-- attraction. (A new enum value can't be used in the migration that adds it, which Postgres runs in
-- one transaction: their settings rows come in the next one.)
ALTER TYPE "attraction" ADD VALUE 'flight' AFTER 'plot8';
ALTER TYPE "attraction" ADD VALUE 'jetski' AFTER 'flight';
ALTER TYPE "attraction" ADD VALUE 'slides' AFTER 'jetski';
ALTER TYPE "attraction" ADD VALUE 'cannons' AFTER 'slides';
ALTER TYPE "attraction" ADD VALUE 'volley' AFTER 'cannons';
