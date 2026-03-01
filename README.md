# fdc-to-sqlite

Imports the [USDA FoodData Central](https://fdc.nal.usda.gov/) CSV dataset into a SQLite database. Downloads the zip, extracts the CSVs, creates tables with matching schemas, bulk-inserts every row, and builds indexes on common lookup columns -- all in one step.

## Requirements

- Node.js 18+
- `unzip` command (pre-installed on macOS and most Linux distros)

## Quick Start

```bash
npm install
npx tsx src/index.ts
```

With no arguments the script downloads the full FDC dataset, imports all 34 tables, and writes `fdcdata/fdc.sqlite`.

## CLI Options

```
npx tsx src/index.ts [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | Current FDC full download URL | Download URL for the zip |
| `--dir <path>` | `fdcdata` | Working directory for zip and extracted files |
| `--out <path>` | `fdcdata/fdc.sqlite` | Output SQLite database path |
| `--tables <list>` | `*` (all) | Comma-separated table names to import, or `*` for all |
| `--types <list>` | *(none -- keep all)* | Comma-separated `data_type` values to keep |
| `--help` | | Show usage and exit |

## Usage Examples

### Full import (all tables, all data types)

```bash
npx tsx src/index.ts
```

### Core nutrition tables, filtered to SR Legacy + Foundation + Survey FNDDS

```bash
npx tsx src/index.ts \
  --tables food,food_nutrient,nutrient,food_category,food_portion,measure_unit,sr_legacy_food,foundation_food,food_nutrient_derivation,food_nutrient_source,food_calorie_conversion_factor,food_nutrient_conversion_factor,food_protein_conversion_factor,food_component,retention_factor,input_food \
  --types sr_legacy_food,foundation_food,survey_fndds_food \
  --out fdcdata/fdc-core.sqlite
```

### Just a few tables

```bash
npx tsx src/index.ts --tables food,food_nutrient,nutrient
```

### Custom output path

```bash
npx tsx src/index.ts --out /tmp/fdc.sqlite
```

### Use a different dataset URL

Visit <https://fdc.nal.usda.gov/download-datasets> to find other dataset URLs (Foundation Foods only, Branded Foods only, etc.):

```bash
npx tsx src/index.ts --url https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2024-10-31.zip
```

## Filtering by Data Type

The `food` table contains rows from several data sources. When `--types` is set, the script deletes rows from `food` that don't match the specified types, then cascades the removal to any table with an `fdc_id` column. Lookup tables (e.g. `nutrient`, `measure_unit`) are not affected, and the database is vacuumed afterwards to reclaim space.

Available data types: `branded_food`, `foundation_food`, `sr_legacy_food`, `survey_fndds_food`, `experimental_food`, `sub_sample_food`, `market_acquistion`, `sample_food`, `agricultural_acquisition`

## How It Works

1. **Download** -- Fetches the zip from `--url` into `--dir`, showing download progress. Skipped if the file already exists.
2. **Extract** -- Runs `unzip` to extract CSV files. Skipped if a `FoodData_Central*` directory already exists in `--dir`.
3. **Import** -- For each CSV, creates a SQLite table (all columns as `TEXT`) and bulk-inserts rows in batches of 5,000 inside transactions for speed.
4. **Filter** -- If `--types` is set, deletes rows from `food` not matching the specified types, then cascades the removal to any table with an `fdc_id` column. Finishes with a `VACUUM`.
5. **Index** -- Creates indexes on common foreign-key and lookup columns (e.g. `fdc_id`, `nutrient_id`, `gtin_upc`).

## Available Tables

The full download contains these CSV files, each imported as a SQLite table:

`acquisition_samples`, `agricultural_samples`, `branded_food`, `fndds_derivation`, `fndds_ingredient_nutrient_value`, `food`, `food_attribute`, `food_attribute_type`, `food_calorie_conversion_factor`, `food_category`, `food_component`, `food_nutrient`, `food_nutrient_conversion_factor`, `food_nutrient_derivation`, `food_nutrient_source`, `food_portion`, `food_protein_conversion_factor`, `food_update_log_entry`, `foundation_food`, `input_food`, `lab_method`, `lab_method_code`, `lab_method_nutrient`, `market_acquisition`, `measure_unit`, `microbe`, `nutrient`, `retention_factor`, `sample_food`, `sr_legacy_food`, `sub_sample_food`, `sub_sample_result`, `survey_fndds_food`, `wweia_food_category`

## Indexed Columns

Indexes are created automatically for fast lookups. Key examples:

| Table | Indexed Columns |
|-------|----------------|
| `food` | `fdc_id`, `data_type`, `food_category_id` |
| `food_nutrient` | `fdc_id`, `nutrient_id`, (`fdc_id`, `nutrient_id`) composite |
| `branded_food` | `fdc_id`, `gtin_upc`, `brand_owner` |
| `nutrient` | `id` |
| `food_category` | `id` |

See the `INDEXES` map in `src/index.ts` for the full list.

## License

GPL-3.0 -- see [LICENSE](LICENSE). The FDC dataset itself is public domain (USDA).
