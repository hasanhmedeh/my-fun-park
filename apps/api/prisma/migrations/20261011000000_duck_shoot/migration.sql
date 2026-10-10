-- The Duck Shoot, a shooting gallery on the Midway, takes tickets like every other attraction. (A new
-- enum value can't be used in the migration that adds it, which Postgres runs in one transaction: its
-- settings row comes in the next one.)
ALTER TYPE "attraction" ADD VALUE 'ducks' AFTER 'striker';
