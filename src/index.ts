import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { parse } from "csv-parse";

interface Config {
  downloadUrl: string;
  dataDir: string;
  outputDb: string;
  tables: string[];
}

const BATCH_SIZE = 5000;
const SKIP_FILES = new Set(["all_downloaded_table_record_counts"]);

function loadConfig(): Config {
  const raw = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "config.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Download ────────────────────────────────────────────────────────────────

async function downloadZip(url: string, dataDir: string): Promise<string> {
  const filename = path.basename(new URL(url).pathname);
  const dest = path.join(dataDir, filename);

  if (fs.existsSync(dest)) {
    console.log(`Zip already exists: ${dest}`);
    return dest;
  }

  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const tmp = dest + ".part";
  const fileStream = fs.createWriteStream(tmp);
  const reader = res.body.getReader();

  let downloaded = 0;
  const contentLength = Number(res.headers.get("content-length") || 0);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;
    if (contentLength > 0) {
      const pct = ((downloaded / contentLength) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(1)} MB)`);
    }
  }

  fileStream.end();
  await new Promise<void>((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });

  fs.renameSync(tmp, dest);
  console.log(`\nDownloaded to ${dest}`);
  return dest;
}

// ── Find most recent zip ────────────────────────────────────────────────────

function findMostRecentZip(dataDir: string): string {
  const entries = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(dataDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (entries.length === 0) {
    throw new Error(`No .zip files found in ${dataDir}`);
  }
  return path.join(dataDir, entries[0].name);
}

// ── Extract ─────────────────────────────────────────────────────────────────

function extractZip(zipPath: string, dataDir: string): string {
  const subdirs = fs
    .readdirSync(dataDir)
    .filter((f) => {
      const full = path.join(dataDir, f);
      return fs.statSync(full).isDirectory() && f.startsWith("FoodData_Central");
    });

  if (subdirs.length > 0) {
    const most = subdirs.sort().pop()!;
    const extracted = path.join(dataDir, most);
    console.log(`Already extracted: ${extracted}`);
    return extracted;
  }

  console.log(`Extracting ${zipPath} ...`);
  execSync(`unzip -o "${zipPath}" -d "${dataDir}"`, { stdio: "inherit" });

  const after = fs
    .readdirSync(dataDir)
    .filter((f) => {
      const full = path.join(dataDir, f);
      return fs.statSync(full).isDirectory() && f.startsWith("FoodData_Central");
    })
    .sort()
    .pop();

  if (!after) {
    throw new Error("Extraction failed: no FoodData_Central directory found");
  }
  return path.join(dataDir, after);
}

// ── Discover CSVs ───────────────────────────────────────────────────────────

function discoverCsvFiles(
  extractedDir: string,
  tables: string[]
): { tableName: string; filePath: string }[] {
  const all = fs
    .readdirSync(extractedDir)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => ({
      tableName: f.replace(/\.csv$/, ""),
      filePath: path.join(extractedDir, f),
    }))
    .filter((f) => !SKIP_FILES.has(f.tableName));

  if (tables.length === 1 && tables[0] === "*") {
    return all;
  }

  const wanted = new Set(tables);
  return all.filter((f) => wanted.has(f.tableName));
}

// ── Import CSV into SQLite ──────────────────────────────────────────────────

async function importCsv(
  db: Database.Database,
  tableName: string,
  filePath: string
): Promise<void> {
  const fileSize = fs.statSync(filePath).size;
  console.log(
    `\nImporting ${tableName} (${(fileSize / 1e6).toFixed(1)} MB) ...`
  );

  return new Promise((resolve, reject) => {
    const parser = createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, relax_column_count: true })
    );

    let columns: string[] | null = null;
    let insert: Database.Statement | null = null;
    let batch: string[][] = [];
    let totalRows = 0;

    const runBatch = () => {
      if (batch.length === 0) return;
      const tx = db.transaction(() => {
        for (const row of batch) {
          insert!.run(...row);
        }
      });
      tx();
      totalRows += batch.length;
      process.stdout.write(`\r  ${totalRows.toLocaleString()} rows`);
      batch = [];
    };

    const sink = new Writable({
      objectMode: true,
      write(record: Record<string, string>, _encoding, callback) {
        if (!columns) {
          columns = Object.keys(record);
          const colDefs = columns.map((c) => `"${c}" TEXT`).join(", ");
          db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
          db.exec(`CREATE TABLE "${tableName}" (${colDefs})`);
          const placeholders = columns.map(() => "?").join(", ");
          insert = db.prepare(
            `INSERT INTO "${tableName}" VALUES (${placeholders})`
          );
        }

        batch.push(columns.map((c) => record[c] ?? ""));

        if (batch.length >= BATCH_SIZE) {
          runBatch();
        }
        callback();
      },
      final(callback) {
        runBatch();
        console.log(`\r  ${totalRows.toLocaleString()} rows -- done`);
        callback();
      },
    });

    pipeline(parser, sink).then(resolve).catch(reject);
  });
}

// ── Indexes ─────────────────────────────────────────────────────────────────

const INDEXES: Record<string, string[][]> = {
  food:                             [["fdc_id"], ["data_type"], ["food_category_id"]],
  food_nutrient:                    [["fdc_id"], ["nutrient_id"], ["fdc_id", "nutrient_id"]],
  branded_food:                     [["fdc_id"], ["gtin_upc"], ["brand_owner"]],
  food_attribute:                   [["fdc_id"], ["food_attribute_type_id"]],
  food_attribute_type:              [["id"]],
  food_calorie_conversion_factor:   [["food_nutrient_conversion_factor_id"]],
  food_category:                    [["id"]],
  food_component:                   [["fdc_id"]],
  food_nutrient_conversion_factor:  [["fdc_id"]],
  food_nutrient_derivation:         [["id"]],
  food_nutrient_source:             [["id"]],
  food_portion:                     [["fdc_id"], ["measure_unit_id"]],
  food_protein_conversion_factor:   [["food_nutrient_conversion_factor_id"]],
  food_update_log_entry:            [["id"]],
  foundation_food:                  [["fdc_id"]],
  input_food:                       [["fdc_id"], ["fdc_id_of_input_food"]],
  lab_method:                       [["id"]],
  lab_method_code:                  [["lab_method_id"]],
  lab_method_nutrient:              [["lab_method_id"], ["nutrient_id"]],
  market_acquisition:               [["fdc_id"]],
  measure_unit:                     [["id"]],
  microbe:                          [["foodId"]],
  nutrient:                         [["id"]],
  sample_food:                      [["fdc_id"]],
  sr_legacy_food:                   [["fdc_id"]],
  sub_sample_food:                  [["fdc_id"], ["fdc_id_of_sample_food"]],
  sub_sample_result:                [["food_nutrient_id"], ["lab_method_id"]],
  survey_fndds_food:                [["fdc_id"], ["food_code"]],
  acquisition_samples:              [["fdc_id_of_sample_food"], ["fdc_id_of_acquisition_food"]],
  agricultural_samples:             [["fdc_id"]],
  fndds_ingredient_nutrient_value:  [["ingredient code"], ["FDC ID"]],
  retention_factor:                 [["n.code"]],
  wweia_food_category:              [["wweia_food_category"]],
};

function createIndexes(db: Database.Database, importedTables: Set<string>) {
  console.log("\nCreating indexes ...");
  let count = 0;

  for (const [table, indexDefs] of Object.entries(INDEXES)) {
    if (!importedTables.has(table)) continue;

    for (const cols of indexDefs) {
      const idxName = `idx_${table}_${cols.join("_")}`.replace(/[^a-zA-Z0-9_]/g, "_");
      const colList = cols.map((c) => `"${c}"`).join(", ");
      db.exec(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table}" (${colList})`);
      count++;
    }
  }

  console.log(`Created ${count} indexes`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const dataDir = path.resolve(import.meta.dirname, "..", config.dataDir);
  ensureDir(dataDir);

  await downloadZip(config.downloadUrl, dataDir);

  const zipPath = findMostRecentZip(dataDir);
  console.log(`Using zip: ${zipPath}`);

  const extractedDir = extractZip(zipPath, dataDir);
  console.log(`Using extracted dir: ${extractedDir}`);

  const csvFiles = discoverCsvFiles(extractedDir, config.tables);
  console.log(`\nFound ${csvFiles.length} CSV tables to import:`);
  csvFiles.forEach((f) => console.log(`  - ${f.tableName}`));

  const dbPath = path.resolve(import.meta.dirname, "..", config.outputDb);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = OFF");

  const importedTables = new Set<string>();
  for (const csv of csvFiles) {
    await importCsv(db, csv.tableName, csv.filePath);
    importedTables.add(csv.tableName);
  }

  createIndexes(db, importedTables);

  db.close();
  const dbSize = fs.statSync(dbPath).size;
  console.log(
    `\nDone! Database written to ${dbPath} (${(dbSize / 1e6).toFixed(1)} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
