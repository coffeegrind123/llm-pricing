#!/usr/bin/env node
/**
 * fetch-pricing.mjs — pull the LLM pricing snapshot from aipricing.guru.
 *
 * Strategy: one HTTP GET against https://www.aipricing.guru/api/pricing.json,
 * then write the payload to `data/`.
 *
 * Output:
 *   data/pricing.json — full upstream payload (lastUpdated, scrapedAt,
 *                       modelCount, providerCount, models[]).
 *   data/models.json  — just the `.models` array, sorted by id for
 *                       deterministic git diffs. This is what openclaude
 *                       reads via the GitHub raw URL.
 *   data/summary.json — provenance + counts (fetched_at, source,
 *                       upstream_last_updated, model_count, provider_count,
 *                       models_per_provider).
 *
 * Usage:
 *   node fetch-pricing.mjs                # default ./data/
 *   node fetch-pricing.mjs --out ./out/   # custom output dir
 *   API_URL=https://other.example/p.json node fetch-pricing.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const API_URL = process.env.API_URL || "https://www.aipricing.guru/api/pricing.json";
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : resolve(import.meta.dirname || ".", "data");
const USER_AGENT = "Mozilla/5.0 (compatible; openclaude-llm-pricing/3.0)";

async function fetchPricing() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} from ${API_URL}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    if (!data || typeof data !== "object") {
      throw new Error("Response is not a JSON object");
    }
    if (!Array.isArray(data.models)) {
      throw new Error("Response missing 'models' array");
    }
    if (data.models.length === 0) {
      throw new Error("Response has empty 'models' array — refusing to overwrite snapshot");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function saveJson(filename, data) {
  const path = resolve(OUT_DIR, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(
    `  -> ${filename} (${JSON.stringify(data).length.toLocaleString()} bytes)`,
  );
}

function normalize(data) {
  // Sort models by id so the daily commit diff shows actual price/status
  // changes rather than upstream array reordering noise.
  const models = [...data.models].sort((a, b) =>
    String(a?.id ?? "").localeCompare(String(b?.id ?? ""))
  );
  return { ...data, models };
}

function buildSummary(data) {
  const perProvider = {};
  for (const m of data.models) {
    const p = m?.provider ?? "unknown";
    perProvider[p] = (perProvider[p] ?? 0) + 1;
  }
  const priced = data.models.filter(
    (m) =>
      typeof m?.pricing?.inputPerM === "number" ||
      typeof m?.pricing?.outputPerM === "number"
  );
  return {
    fetched_at: new Date().toISOString(),
    source: API_URL,
    upstream_last_updated: data.lastUpdated ?? null,
    upstream_scraped_at: data.scrapedAt ?? null,
    model_count: data.models.length,
    priced_model_count: priced.length,
    provider_count: Object.keys(perProvider).length,
    models_per_provider: Object.fromEntries(
      Object.entries(perProvider).sort(([a], [b]) => a.localeCompare(b))
    ),
  };
}

async function main() {
  console.log("aipricing.guru fetcher");
  console.log(`  API URL : ${API_URL}`);
  console.log(`  Output  : ${OUT_DIR}\n`);

  await mkdir(OUT_DIR, { recursive: true });

  console.log("Fetching pricing snapshot...");
  const raw = await fetchPricing();
  const data = normalize(raw);
  console.log(
    `  upstream lastUpdated: ${data.lastUpdated ?? "(none)"}\n` +
      `  models: ${data.models.length}, providers: ${
        new Set(data.models.map((m) => m?.provider)).size
      }\n`
  );

  await saveJson("pricing.json", data);
  await saveJson("models.json", data.models);
  await saveJson("summary.json", buildSummary(data));

  console.log(`\nDone. Files written to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error("\nFATAL:", err?.stack || err?.message || err);
  process.exit(1);
});
