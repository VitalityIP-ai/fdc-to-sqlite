import { config } from "dotenv";
import * as sqliteVec from "sqlite-vec";
import OpenAI from "openai";
import type Database from "better-sqlite3";

const EMBEDDING_BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info("${table}")`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) as { name: string } | undefined;
  return !!row;
}

export async function buildEmbeddings(
  db: Database.Database,
  importedTables: Set<string>
): Promise<void> {
  config();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for --embeddings. Add it to your .env file (see .env.example)."
    );
  }

  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

  if (!importedTables.has("food")) {
    console.log("\nSkipping embeddings (food table not imported)");
    return;
  }

  if (!tableHasColumn(db, "food", "description")) {
    console.log("\nSkipping embeddings (food table has no description column)");
    return;
  }

  console.log("\nBuilding embeddings for food descriptions ...");
  sqliteVec.load(db);

  const vecTableExists = tableExists(db, "food_description_embedding");
  if (!vecTableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE food_description_embedding USING vec0(
        fdc_id integer primary key,
        description_embedding float[1536]
      )
    `);
  }

  const existingCount = vecTableExists
    ? (db.prepare("SELECT COUNT(*) as n FROM food_description_embedding").get() as { n: number }).n
    : 0;

  const rawRows = db
    .prepare(
      `SELECT fdc_id, description FROM food
       WHERE description IS NOT NULL AND description != ''
       AND fdc_id NOT IN (SELECT fdc_id FROM food_description_embedding)`
    )
    .all() as { fdc_id: string; description: string }[];

  const rows = rawRows.filter((r) => {
    const n = parseInt(r.fdc_id, 10);
    return !isNaN(n) && String(n) === r.fdc_id.trim();
  });
  if (rows.length < rawRows.length) {
    console.log(`  Skipped ${rawRows.length - rows.length} rows with non-integer fdc_id`);
  }

  const total = rows.length;
  if (total === 0) {
    console.log(`  All ${existingCount.toLocaleString()} food descriptions already embedded`);
    return;
  }

  if (existingCount > 0) {
    console.log(`  Resuming: ${existingCount.toLocaleString()} already embedded, ${total.toLocaleString()} remaining`);
  }

  const openai = new OpenAI({ apiKey });
  const insertStmt = db.prepare(
    "INSERT INTO food_description_embedding (fdc_id, description_embedding) VALUES (?, ?)"
  );

  const totalBatches = Math.ceil(total / EMBEDDING_BATCH_SIZE);
  let embedded = 0;

  for (let i = 0; i < total; i += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

    const response = await openai.embeddings.create({
      model,
      input: batch.map((r) => r.description),
    });

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const fdcId = BigInt(parseInt(row.fdc_id, 10));
        const embedding = new Float32Array(response.data[j].embedding);
        insertStmt.run(fdcId, embedding);
      }
    });
    tx();

    embedded += batch.length;
    process.stdout.write(
      `\r  Embedding batch ${batchNum}/${totalBatches} (${embedded.toLocaleString()} of ${total.toLocaleString()})`
    );

    if (i + EMBEDDING_BATCH_SIZE < total) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\n  Done! Embedded ${embedded.toLocaleString()} food descriptions`);
}
