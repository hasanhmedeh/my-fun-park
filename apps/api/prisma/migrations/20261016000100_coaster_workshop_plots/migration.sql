-- Every attraction has a settings row, so the office lists it: Creators' Valley's eight plots cost
-- 1 ticket a ride and are open (staff set the price when they release a coaster onto one).
INSERT INTO "attraction_settings" ("attraction", "tickets")
VALUES ('plot1', 1), ('plot2', 1), ('plot3', 1), ('plot4', 1), ('plot5', 1), ('plot6', 1), ('plot7', 1), ('plot8', 1)
ON CONFLICT ("attraction") DO NOTHING;
