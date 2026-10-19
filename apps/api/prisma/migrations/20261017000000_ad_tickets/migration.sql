-- Free tickets for watching an ad: once the free pack isn't ready (still cooling down, or the cap
-- reached), a member can watch a rewarded ad for park_settings.ad_tickets tickets, up to
-- ads_per_day times in 24 hours. Ad tickets go on top of ticket_cap. 0 tickets switches ads off.

-- AlterTable
ALTER TABLE "park_settings" ADD COLUMN "ad_tickets" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "ads_per_day" INTEGER NOT NULL DEFAULT 5,
-- Not modelled by Prisma: the office's limits.
ADD CONSTRAINT "park_settings_ad_tickets_check" CHECK ("ad_tickets" BETWEEN 0 AND 1000),
ADD CONSTRAINT "park_settings_ads_per_day_check" CHECK ("ads_per_day" BETWEEN 1 AND 100);

-- CreateTable
CREATE TABLE "ad_views" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewarded_at" TIMESTAMP(3),
    "tickets" INTEGER,

    CONSTRAINT "ad_views_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: an ad gives tickets, never takes them.
    CONSTRAINT "ad_views_tickets_check" CHECK ("tickets" IS NULL OR "tickets" >= 0)
);

-- CreateIndex
CREATE INDEX "ad_views_user_id_rewarded_at_idx" ON "ad_views"("user_id", "rewarded_at");

-- CreateIndex
CREATE INDEX "ad_views_rewarded_at_idx" ON "ad_views"("rewarded_at");

-- AddForeignKey
ALTER TABLE "ad_views" ADD CONSTRAINT "ad_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
