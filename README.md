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

The script will:

1. Download the FDC "Full Download of All Data Types" zip (~458 MB) into `fdcdata/`
2. Extract the CSV files
3. Import every CSV table into `fdcdata/fdc.sqlite`
4. Create indexes on frequently queried columns

Each step is idempotent -- if the zip has already been downloaded or extracted, those steps are skipped automatically. The database is always rebuilt from scratch.

## Configuration

Edit `config.json` to customize behavior:

```json
{
  "downloadUrl": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_csv_2025-12-18.zip",
  "dataDir": "fdcdata",
  "outputDb": "fdcdata/fdc.sqlite",
  "tables": ["*"]
}
```

| Field         | Description |
|---------------|-------------|
| `downloadUrl` | URL of the FDC CSV zip to download |
| `dataDir`     | Local directory for the zip and extracted files |
| `outputDb`    | Path for the output SQLite database |
| `tables`      | `["*"]` for all tables, or a list of specific table names to import |

### Importing specific tables

To import only a subset of tables, list them by name (the CSV filename without `.csv`):

```json
{
  "tables": ["food", "food_nutrient", "nutrient", "branded_food", "food_category"]
}
```

### Using a different dataset

Visit <https://fdc.nal.usda.gov/download-datasets> to find other dataset URLs (Foundation Foods only, Branded Foods only, etc.) and set `downloadUrl` accordingly.

## How It Works

1. **Download** -- Fetches the zip from `downloadUrl` into `dataDir`, showing download progress. Skipped if the file already exists.
2. **Extract** -- Runs `unzip` to extract CSV files. Skipped if a `FoodData_Central*` directory already exists in `dataDir`.
3. **Import** -- For each CSV, creates a SQLite table (all columns as `TEXT`) and bulk-inserts rows in batches of 5,000 inside transactions for speed.
4. **Index** -- Creates indexes on common foreign-key and lookup columns (e.g. `fdc_id`, `nutrient_id`, `gtin_upc`).

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
