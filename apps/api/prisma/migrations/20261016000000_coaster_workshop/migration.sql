-- The Coaster Workshop: members buy coaster parts with tickets (or take their free starter kit),
-- build coasters in the Builder's Yard, and send them to staff, who release the best onto the eight
-- plots of Creators' Valley. Each plot is an attraction like any other (priced and closed in the
-- office). (A new enum value can't be used in the migration that adds it, which Postgres runs in one
-- transaction: the plots' settings rows come in the next one.)
ALTER TYPE "attraction" ADD VALUE 'plot1' AFTER 'ducks';
ALTER TYPE "attraction" ADD VALUE 'plot2' AFTER 'plot1';
ALTER TYPE "attraction" ADD VALUE 'plot3' AFTER 'plot2';
ALTER TYPE "attraction" ADD VALUE 'plot4' AFTER 'plot3';
ALTER TYPE "attraction" ADD VALUE 'plot5' AFTER 'plot4';
ALTER TYPE "attraction" ADD VALUE 'plot6' AFTER 'plot5';
ALTER TYPE "attraction" ADD VALUE 'plot7' AFTER 'plot6';
ALTER TYPE "attraction" ADD VALUE 'plot8' AFTER 'plot7';

-- CreateEnum
CREATE TYPE "coaster_part" AS ENUM ('steel', 'lift', 'launch', 'brakes', 'loop', 'corkscrew', 'station', 'car');

-- CreateEnum
CREATE TYPE "creation_status" AS ENUM ('pending', 'released', 'declined', 'removed', 'replaced');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "starter_kit_at" TIMESTAMP(3),
ADD COLUMN "extra_design_slots" INTEGER NOT NULL DEFAULT 0,
-- Not modelled by Prisma: nobody has fewer than no extra slots.
ADD CONSTRAINT "users_extra_design_slots_check" CHECK ("extra_design_slots" >= 0);

-- AlterTable
ALTER TABLE "ride_rounds" ADD COLUMN "creation_id" TEXT,
ADD COLUMN "royalty" INTEGER NOT NULL DEFAULT 0,
-- Not modelled by Prisma: a royalty is paid, never taken.
ADD CONSTRAINT "ride_rounds_royalty_check" CHECK ("royalty" >= 0);

-- CreateTable
CREATE TABLE "coaster_parts" (
    "user_id" TEXT NOT NULL,
    "part" "coaster_part" NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "coaster_parts_pkey" PRIMARY KEY ("user_id","part"),
    -- Not modelled by Prisma: nobody owns fewer than none.
    CONSTRAINT "coaster_parts_quantity_check" CHECK ("quantity" >= 0)
);

-- CreateTable
CREATE TABLE "coaster_part_settings" (
    "part" "coaster_part" NOT NULL,
    "tickets" INTEGER NOT NULL,
    "stock" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coaster_part_settings_pkey" PRIMARY KEY ("part"),
    -- Not modelled by Prisma: a part always costs something, and the stock never goes below zero.
    CONSTRAINT "coaster_part_settings_tickets_check" CHECK ("tickets" BETWEEN 1 AND 1000),
    CONSTRAINT "coaster_part_settings_stock_check" CHECK ("stock" IS NULL OR "stock" >= 0)
);

-- CreateTable
CREATE TABLE "coaster_part_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "part" "coaster_part" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "tickets_spent" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coaster_part_orders_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: an order is for a sensible number of parts, and costs something.
    CONSTRAINT "coaster_part_orders_quantity_check" CHECK ("quantity" BETWEEN 1 AND 50),
    CONSTRAINT "coaster_part_orders_tickets_spent_check" CHECK ("tickets_spent" >= 0)
);

-- CreateTable
CREATE TABLE "coaster_designs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "parts" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coaster_designs_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: a coaster has a name, and not a long one.
    CONSTRAINT "coaster_designs_name_check" CHECK (char_length("name") BETWEEN 1 AND 24)
);

-- CreateTable
CREATE TABLE "creations" (
    "id" TEXT NOT NULL,
    "design_id" TEXT,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "picture" BYTEA,
    "picture_type" TEXT,
    "status" "creation_status" NOT NULL DEFAULT 'pending',
    "status_changed_at" TIMESTAMP(3),
    "plot" INTEGER,
    "reply" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_by_name" TEXT,
    "released_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creations_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: a coaster has a short name, a released one stands on one of the eight
    -- plots, staff's reply says something (but not too much), and the picture is small.
    CONSTRAINT "creations_name_check" CHECK (char_length("name") BETWEEN 1 AND 24),
    CONSTRAINT "creations_plot_check" CHECK ("plot" IS NULL OR "plot" BETWEEN 1 AND 8),
    CONSTRAINT "creations_released_plot_check" CHECK ("status" <> 'released' OR "plot" IS NOT NULL),
    CONSTRAINT "creations_reply_check" CHECK ("reply" IS NULL OR char_length("reply") BETWEEN 1 AND 500),
    CONSTRAINT "creations_picture_check" CHECK ("picture" IS NULL OR octet_length("picture") <= 122880)
);

-- CreateIndex
CREATE INDEX "coaster_part_orders_user_id_created_at_idx" ON "coaster_part_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "coaster_part_orders_created_at_idx" ON "coaster_part_orders"("created_at");

-- CreateIndex
CREATE INDEX "coaster_designs_user_id_updated_at_idx" ON "coaster_designs"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "creations_status_created_at_idx" ON "creations"("status", "created_at");

-- CreateIndex
CREATE INDEX "creations_user_id_created_at_idx" ON "creations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "creations_design_id_idx" ON "creations"("design_id");

-- CreateIndex
CREATE INDEX "creations_created_at_idx" ON "creations"("created_at");

-- Not modelled by Prisma: one released coaster per plot (two staff releasing onto the same plot at
-- once: the second one fails).
CREATE UNIQUE INDEX "creations_released_plot_key" ON "creations"("plot") WHERE "status" = 'released';

-- AddForeignKey
ALTER TABLE "ride_rounds" ADD CONSTRAINT "ride_rounds_creation_id_fkey" FOREIGN KEY ("creation_id") REFERENCES "creations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaster_parts" ADD CONSTRAINT "coaster_parts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaster_part_orders" ADD CONSTRAINT "coaster_part_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaster_designs" ADD CONSTRAINT "coaster_designs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creations" ADD CONSTRAINT "creations_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "coaster_designs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creations" ADD CONSTRAINT "creations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creations" ADD CONSTRAINT "creations_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
