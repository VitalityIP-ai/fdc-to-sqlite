#!/usr/bin/env npx tsx
/**
 * Audit branded_food data for duplicates and data quality.
 *
 * Usage: npx tsx src/audit-branded-food.ts [--db path/to/fdc.sqlite]
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_DB = "fdc.sqlite";

function main() {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--db" || args[i] === "-d") && args[i + 1]) {
      dbPath = args[++i];
      break;
    }
  }

  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Database not found: ${resolvedPath}`);
    process.exit(1);
  }

  const db = new Database(resolvedPath, { readonly: true });

  console.log(`Auditing: ${resolvedPath}\n`);

  // 1. food table: branded_food rows
  const foodBranded = db
    .prepare(
      `SELECT COUNT(*) as n FROM food WHERE data_type = 'branded_food'`
    )
    .get() as { n: number };
  console.log(`food (data_type='branded_food'): ${foodBranded.n.toLocaleString()} rows`);

  // 2. branded_food table
  const brandedTable = db
    .prepare(`SELECT COUNT(*) as n FROM branded_food`)
    .get() as { n: number };
  console.log(`branded_food table:              ${brandedTable.n.toLocaleString()} rows`);

  // 3. Duplicate fdc_id in food (branded only)
  const dupFoodFdc = db.prepare(`
    SELECT fdc_id, COUNT(*) as cnt
    FROM food
    WHERE data_type = 'branded_food'
    GROUP BY fdc_id
    HAVING cnt > 1
  `).all() as { fdc_id: string; cnt: number }[];
  console.log(`\nDuplicate fdc_id in food (branded): ${dupFoodFdc.length > 0 ? dupFoodFdc.length + " duplicates" : "none"}`);
  if (dupFoodFdc.length > 0 && dupFoodFdc.length <= 5) {
    dupFoodFdc.forEach((r) => console.log(`  fdc_id ${r.fdc_id}: ${r.cnt} rows`));
  } else if (dupFoodFdc.length > 5) {
    console.log(`  (showing first 5)`);
    dupFoodFdc.slice(0, 5).forEach((r) => console.log(`  fdc_id ${r.fdc_id}: ${r.cnt} rows`));
  }

  // 4. Duplicate fdc_id in branded_food
  const dupBrandedFdc = db.prepare(`
    SELECT fdc_id, COUNT(*) as cnt
    FROM branded_food
    GROUP BY fdc_id
    HAVING cnt > 1
  `).all() as { fdc_id: string; cnt: number }[];
  console.log(`\nDuplicate fdc_id in branded_food:  ${dupBrandedFdc.length > 0 ? dupBrandedFdc.length + " duplicates" : "none"}`);
  if (dupBrandedFdc.length > 0 && dupBrandedFdc.length <= 5) {
    dupBrandedFdc.forEach((r) => console.log(`  fdc_id ${r.fdc_id}: ${r.cnt} rows`));
  } else if (dupBrandedFdc.length > 5) {
    console.log(`  (showing first 5)`);
    dupBrandedFdc.slice(0, 5).forEach((r) => console.log(`  fdc_id ${r.fdc_id}: ${r.cnt} rows`));
  }

  // 5. food branded rows NOT in branded_food (orphans)
  const orphans = db.prepare(`
    SELECT COUNT(*) as n
    FROM food f
    LEFT JOIN branded_food b ON f.fdc_id = b.fdc_id
    WHERE f.data_type = 'branded_food' AND b.fdc_id IS NULL
  `).get() as { n: number };
  console.log(`\nfood branded rows not in branded_food: ${orphans.n.toLocaleString()}`);

  // 6. branded_food rows NOT in food (orphans)
  const orphanBranded = db.prepare(`
    SELECT COUNT(*) as n
    FROM branded_food b
    LEFT JOIN food f ON f.fdc_id = b.fdc_id AND f.data_type = 'branded_food'
    WHERE f.fdc_id IS NULL
  `).get() as { n: number };
  console.log(`branded_food rows not in food:      ${orphanBranded.n.toLocaleString()}`);

  // 7. Duplicate gtin_upc (same UPC, different products - common for store brands)
  const dupUpc = db.prepare(`
    SELECT COUNT(*) as upc_count, COALESCE(SUM(cnt), 0) as row_count FROM (
      SELECT COUNT(*) as cnt FROM branded_food
      WHERE gtin_upc IS NOT NULL AND gtin_upc != ''
      GROUP BY gtin_upc HAVING COUNT(*) > 1
    )
  `).get() as { upc_count: number; row_count: number };
  console.log(`\nDuplicate gtin_upc (same UPC, diff products): ${dupUpc.upc_count.toLocaleString()} UPCs`);
  if (dupUpc.upc_count > 0) {
    console.log(`  (${dupUpc.row_count.toLocaleString()} rows share a UPC with another row)`);
  }

  // 8. Distinct descriptions (are many rows same description?)
  const distinctDesc = db.prepare(`
    SELECT COUNT(DISTINCT description) as n
    FROM food
    WHERE data_type = 'branded_food' AND description IS NOT NULL AND description != ''
  `).get() as { n: number };
  console.log(`\nDistinct descriptions (branded):    ${distinctDesc.n.toLocaleString()}`);
  if (foodBranded.n > 0) {
    const pct = ((distinctDesc.n / foodBranded.n) * 100).toFixed(1);
    console.log(`  (${pct}% unique - lower means more duplicate/similar descriptions)`);
  }

  db.close();
}

main();
