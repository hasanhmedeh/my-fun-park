-- The visitor's look from the game's customiser (which person they play, their outfit's colours,
-- hair tint, height and build), kept on the account so it follows a member to any browser. The API
-- checks its shape (src/auth/visitor-look.ts); null until the member saves one.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "visitor_look" JSONB,
-- Not modelled by Prisma: a look is an object (or none at all).
ADD CONSTRAINT "users_visitor_look_check" CHECK ("visitor_look" IS NULL OR jsonb_typeof("visitor_look") = 'object');
