-- Every attraction has a settings row, so the office lists it: a flight costs 10 tickets (the fair's
-- biggest ride, a whole flight from boarding to the stand), the island's four 1 ticket a go, and all
-- five are open.
INSERT INTO "attraction_settings" ("attraction", "tickets")
VALUES ('flight', 10), ('jetski', 1), ('slides', 1), ('cannons', 1), ('volley', 1)
ON CONFLICT ("attraction") DO NOTHING;
