-- Every attraction has a settings row, so the office lists it (1 ticket a round, open).
INSERT INTO "attraction_settings" ("attraction", "tickets") VALUES ('ducks', 1)
ON CONFLICT ("attraction") DO NOTHING;
