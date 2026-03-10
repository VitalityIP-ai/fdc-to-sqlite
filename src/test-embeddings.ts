#!/usr/bin/env npx tsx
/**
 * Test script for embedding search.
 *
 * Usage:
 *   npx tsx src/test-embeddings.ts --search "chicken breast" [--db path/to/fdc.sqlite] [--limit 10]
 *
 * Prints fdc_id, description, data_type, and distance, sorted by relevance (closest first).
 */

import { config } from "dotenv";
import * as sqliteVec from "sqlite-vec";
import OpenAI from "openai";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_DB = "fdc.sqlite";
const DEFAULT_LIMIT = 10;

function parseArgs(): { search: string; db: string; limit: number } {
  const args = process.argv.slice(2);
  let search = "";
  let db = DEFAULT_DB;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--search":
      case "-s":
        search = args[++i] ?? "";
        break;
      case "--db":
      case "-d":
        db = args[++i] ?? DEFAULT_DB;
        break;
      case "--limit":
      case "-l":
        limit = parseInt(args[++i] ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
        break;
      case "--help":
      case "-h":
        console.log(`
Usage: npx tsx src/test-embeddings.ts --search "<query>" [options]

Options:
  --search, -s   Search query (required)
  --db, -d       Path to SQLite database with embeddings (default: fdc.sqlite)
  --limit, -l    Max number of results (default: 10)
  --help, -h     Show this help

Example:
  npx tsx src/test-embeddings.ts --search "chicken breast" --db fdc.sqlite --limit 5
`.trim());
        process.exit(0);
    }
  }

  return { search, db, limit };
}

async function main() {
  config();

  const { search, db: dbPath, limit } = parseArgs();

  if (!search.trim()) {
    console.error("Error: --search is required");
    console.error("Run with --help for usage");
    process.exit(1);
  }

  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Database not found: ${resolvedPath}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY is required. Add it to your .env file.");
    process.exit(1);
  }

  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

  const db = new Database(resolvedPath, { readonly: true });
  sqliteVec.load(db);

  // Check that embedding table exists
  const vecExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'food_description_embedding'"
    )
    .get();
  if (!vecExists) {
    console.error("Error: food_description_embedding table not found. Run with --embeddings first.");
    db.close();
    process.exit(1);
  }

  console.log(`Searching for: "${search}"`);
  console.log(`Database: ${resolvedPath}`);
  console.log("");

  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({
    model,
    input: search,
  });
  const queryEmbedding = new Float32Array(response.data[0].embedding);

  const rows = db
    .prepare(
      `WITH knn AS (
        SELECT fdc_id, distance
        FROM food_description_embedding
        WHERE description_embedding MATCH ?
        AND k = ?
      )
      SELECT
        knn.fdc_id,
        food.description,
        food.data_type,
        knn.distance
      FROM knn
      LEFT JOIN food ON food.fdc_id = CAST(knn.fdc_id AS TEXT)
      ORDER BY knn.distance ASC`
    )
    .all(queryEmbedding, limit) as {
    fdc_id: number;
    description: string | null;
    data_type: string | null;
    distance: number;
  }[];

  if (rows.length === 0) {
    console.log("No results found.");
    db.close();
    return;
  }

  const maxIdLen = Math.max(8, ...rows.map((r) => String(r.fdc_id).length));
  const maxTypeLen = Math.max(10, ...rows.map((r) => (r.data_type ?? "").length));
  const header = [
    "fdc_id".padEnd(maxIdLen),
    "distance".padEnd(10),
    "data_type".padEnd(maxTypeLen),
    "description",
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    const desc = (row.description ?? "").slice(0, 80);
    const truncated = (row.description ?? "").length > 80 ? "..." : "";
    console.log(
      [
        String(row.fdc_id).padEnd(maxIdLen),
        row.distance.toFixed(4).padEnd(10),
        (row.data_type ?? "").padEnd(maxTypeLen),
        desc + truncated,
      ].join("  ")
    );
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
