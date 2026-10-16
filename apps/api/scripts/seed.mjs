// Keeps the park's setup in prisma/seed.json, so a reset or brand-new database can be refilled:
//   pnpm db:snapshot             copy the setup from the database into prisma/seed.json   (apps/api/.env)
//   pnpm db:seed                 write prisma/seed.json back into the database
// Add --prod to run against apps/api/.env.production instead (the file `pnpm studio:prod` uses).
// The setup is what staff edit in The Ringmaster's Office: the park's switches (park_settings, private
// access included), the addresses let in while the fair is private (allowed_ips), each attraction's
// price and open/closed sign (attraction_settings), each shop item's price and stock
// (shop_item_settings), and each Coaster Workshop part's (coaster_part_settings). Seeding overwrites those rows (allowed_ips becomes exactly the file's list)
// and leaves accounts, rounds and orders alone.
// Run `pnpm db:snapshot --prod` after changing the setup, and commit prisma/seed.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const [command] = args.filter((a) => a !== '--prod');

if (!['seed', 'snapshot'].includes(command)) {
  console.error('Usage: pnpm db:seed | pnpm db:snapshot   (add --prod for production)');
  process.exit(1);
}

const seedFile = path.join(import.meta.dirname, '..', 'prisma', 'seed.json');
const file = path.join(import.meta.dirname, '..', prod ? '.env.production' : '.env');
if (!existsSync(file)) {
  console.error(`apps/api/${path.basename(file)} not found.${prod ? ' Create it with the production DATABASE_URL (see scripts/studio.mjs).' : ' Run `pnpm dev` once to create it.'}`);
  process.exit(1);
}
const env = { ...parseEnv(readFileSync(file, 'utf8')), ...(prod ? {} : process.env) };
const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL is not set in apps/api/${path.basename(file)}.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (prod) console.log(`\n  ⚠️  PRODUCTION database (${new URL(url).hostname}).\n`);
  if (command === 'snapshot') await snapshot();
  else await seed();
} finally {
  await client.end();
}

async function snapshot() {
  const park = await client.query(
    `SELECT open, closed_message, under_maintenance, maintenance_message, pack_size, cooldown_hours, ticket_cap, allowlist_only FROM park_settings WHERE id = 1`,
  );
  const allowed = await client.query(`SELECT ip, label, added_by FROM allowed_ips ORDER BY created_at, id`);
  const attractions = await client.query(`SELECT attraction, tickets, open, closed_message FROM attraction_settings ORDER BY attraction`);
  const shop = await client.query(`SELECT item, tickets, stock FROM shop_item_settings ORDER BY item`);
  const workshop = await client.query(`SELECT part::text AS part, tickets, stock FROM coaster_part_settings ORDER BY part`);

  const data = {
    park: park.rows[0]
      ? {
          open: park.rows[0].open,
          closedMessage: park.rows[0].closed_message,
          underMaintenance: park.rows[0].under_maintenance,
          maintenanceMessage: park.rows[0].maintenance_message,
          packSize: park.rows[0].pack_size,
          cooldownHours: park.rows[0].cooldown_hours,
          ticketCap: park.rows[0].ticket_cap,
          allowlistOnly: park.rows[0].allowlist_only,
        }
      : null,
    allowedIps: allowed.rows.map((r) => ({ ip: r.ip, label: r.label, addedBy: r.added_by })),
    attractions: Object.fromEntries(
      attractions.rows.map((r) => [r.attraction, { tickets: r.tickets, open: r.open, closedMessage: r.closed_message }]),
    ),
    shop: Object.fromEntries(shop.rows.map((r) => [r.item, { tickets: r.tickets, stock: r.stock }])),
    workshop: Object.fromEntries(workshop.rows.map((r) => [r.part, { tickets: r.tickets, stock: r.stock }])),
  };
  writeFileSync(seedFile, JSON.stringify(data, null, 2) + '\n');
  console.log(
    `Saved the park, ${allowed.rows.length} allowed addresses, ${attractions.rows.length} attractions, ${shop.rows.length} shop items and ${workshop.rows.length} coaster parts to apps/api/prisma/seed.json. Commit it.`,
  );
}

async function seed() {
  if (!existsSync(seedFile)) {
    console.error('apps/api/prisma/seed.json not found. Make it with `pnpm db:snapshot`.');
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(seedFile, 'utf8'));
  // the columns are UTC timestamps without a zone (as Prisma writes them), whatever the server's time zone
  const now = `now() AT TIME ZONE 'UTC'`;

  // an attraction the schema no longer has can't be written (its enum value is gone): skip it
  const { rows: known } = await client.query(`SELECT unnest(enum_range(NULL::"attraction"))::text AS a`);
  const attractions = Object.entries(data.attractions ?? {});
  const skipped = attractions.filter(([a]) => !known.some((k) => k.a === a)).map(([a]) => a);
  const allowedIps = data.allowedIps ?? [];
  // private access with nobody on the list would shut everyone out, staff included
  const allowlistOnly = !!data.park?.allowlistOnly && allowedIps.length > 0;
  if (data.park?.allowlistOnly && !allowlistOnly) console.log('Private access is on in seed.json, but no address is allowed: seeding it off.');

  await client.query('BEGIN');
  try {
    if (data.park) {
      const p = data.park;
      await client.query(
        `INSERT INTO park_settings (id, open, closed_message, under_maintenance, maintenance_message, pack_size, cooldown_hours, ticket_cap, allowlist_only, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, ${now})
         ON CONFLICT (id) DO UPDATE SET open = $1, closed_message = $2, under_maintenance = $3,
           maintenance_message = $4, pack_size = $5, cooldown_hours = $6, ticket_cap = $7, allowlist_only = $8, updated_at = ${now}`,
        [p.open, p.closedMessage, p.underMaintenance, p.maintenanceMessage, p.packSize, p.cooldownHours, p.ticketCap ?? null, allowlistOnly],
      );
    }
    if (data.allowedIps) {
      await client.query(`DELETE FROM allowed_ips`);
      for (const a of allowedIps) {
        await client.query(
          `INSERT INTO allowed_ips (id, ip, label, added_by, created_at) VALUES (gen_random_uuid()::text, $1, $2, $3, ${now})`,
          [a.ip, a.label ?? null, a.addedBy ?? 'cli'],
        );
      }
    }
    for (const [attraction, a] of attractions) {
      if (skipped.includes(attraction)) continue;
      await client.query(
        `INSERT INTO attraction_settings (attraction, tickets, open, closed_message, updated_at)
         VALUES ($1, $2, $3, $4, ${now})
         ON CONFLICT (attraction) DO UPDATE SET tickets = $2, open = $3, closed_message = $4, updated_at = ${now}`,
        [attraction, a.tickets, a.open, a.closedMessage],
      );
    }
    for (const [item, s] of Object.entries(data.shop ?? {})) {
      await client.query(
        `INSERT INTO shop_item_settings (item, tickets, stock, updated_at)
         VALUES ($1, $2, $3, ${now})
         ON CONFLICT (item) DO UPDATE SET tickets = $2, stock = $3, updated_at = ${now}`,
        [item, s.tickets, s.stock],
      );
    }
    for (const [part, s] of Object.entries(data.workshop ?? {})) {
      await client.query(
        `INSERT INTO coaster_part_settings (part, tickets, stock, updated_at)
         VALUES ($1::coaster_part, $2, $3, ${now})
         ON CONFLICT (part) DO UPDATE SET tickets = $2, stock = $3, updated_at = ${now}`,
        [part, s.tickets, s.stock],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  if (skipped.length) console.log(`Skipped attractions the schema no longer has: ${skipped.join(', ')}.`);
  console.log(
    `Seeded ${data.park ? 'the park, ' : ''}${data.allowedIps ? `${allowedIps.length} allowed addresses, ` : ''}${attractions.length - skipped.length} attractions, ${Object.keys(data.shop ?? {}).length} shop items and ${Object.keys(data.workshop ?? {}).length} coaster parts from apps/api/prisma/seed.json.`,
  );
}
