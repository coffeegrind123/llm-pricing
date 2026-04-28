#!/usr/bin/env node
/**
 * fetch-pricing.mjs — exhaustive PricePerToken MCP scraper.
 *
 * Strategy:
 *   1. /get_providers     → list of 70+ authors (z-ai, openai, deepseek, …)
 *   2. /get_all_models    per author with limit=1000 → full model list per provider
 *   3. /get_model         per slug → rich detail (cache_read/write prices,
 *                                    benchmarks, capabilities, modalities)
 *   4. /get_benchmarks    × {coding, math, intelligence}
 *   5. /get_provider_slugs per model slug → cross-provider model IDs
 *      (Bedrock, Groq, OpenRouter, etc.)
 *
 * Output: plain JSON arrays / objects under `data/` — no MCP `{content:[{type,
 * text}]}` envelope. Arrays at the top level so consumers can `JSON.parse` and
 * use directly.
 *
 * Usage:
 *   node fetch-pricing.mjs                     # default ./data/
 *   node fetch-pricing.mjs --out ./out/        # custom output dir
 *   CONCURRENCY=10 node fetch-pricing.mjs      # parallel get_model fetches
 *   SKIP_DETAIL=1 node fetch-pricing.mjs       # skip per-slug detail pass
 *   SKIP_PROVIDER_SLUGS=1 node fetch-pricing.mjs
 *   MCP_URL=https://api.pricepertoken.com/mcp/mcp node fetch-pricing.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const MCP_URL = process.env.MCP_URL || "https://api.pricepertoken.com/mcp/mcp";
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : resolve(import.meta.dirname || ".", "data");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const SKIP_DETAIL = process.env.SKIP_DETAIL === "1";
const SKIP_PROVIDER_SLUGS = process.env.SKIP_PROVIDER_SLUGS === "1";
const USER_AGENT = "Mozilla/5.0 (compatible; openclaude-llm-pricing/2.0)";

// ---- JSON-RPC over MCP ------------------------------------------------------
let nextId = 1;

async function rpc(method, params, { retries = 3 } = {}) {
  const body = { jsonrpc: "2.0", id: nextId++, method };
  if (params) body.params = params;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`);
      }
      // Server may answer with bare JSON or with SSE. Sniff.
      const text = await res.text();
      let payload;
      if (text.startsWith("{")) {
        payload = JSON.parse(text);
      } else {
        // SSE: extract the `data:` line
        const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!dataLine) throw new Error(`unparseable SSE: ${text.slice(0, 200)}`);
        payload = JSON.parse(dataLine.slice("data:".length).trim());
      }
      if (payload.error) {
        throw new Error(`RPC error on ${method}: ${JSON.stringify(payload.error)}`);
      }
      return payload.result;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function notify(method, params) {
  const body = { jsonrpc: "2.0", method };
  if (params) body.params = params;
  await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  // Tool results are wrapped: { content: [{type:'text', text:'...json...'}],
  //                             structuredContent?, isError? }
  // Unwrap to the parsed text payload so callers don't worry about it.
  if (result?.isError) {
    const msg = result?.content?.[0]?.text ?? JSON.stringify(result);
    throw new Error(`Tool ${name} returned isError=true: ${msg.slice(0, 300)}`);
  }
  const text = result?.content?.[0]?.text;
  if (text == null) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text; // some endpoints return free-form text
  }
}

async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "llm-pricing-fetcher", version: "2.0.0" },
  });
  await notify("notifications/initialized", {});
  return result;
}

// ---- Concurrency limiter ----------------------------------------------------
async function pMap(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length || 1) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          results[i] = { __error: String(e?.message || e), __input: items[i] };
        }
        done++;
        if (done % 25 === 0 || done === total) {
          process.stdout.write(`\r    ${done}/${total}  `);
        }
      }
    },
  );
  await Promise.all(workers);
  if (total > 0) process.stdout.write("\n");
  return results;
}

// ---- IO helpers -------------------------------------------------------------
async function saveJson(filename, data) {
  const path = resolve(OUT_DIR, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(
    `  -> ${filename} (${JSON.stringify(data).length.toLocaleString()} bytes)`,
  );
}

// ---- Pipeline ---------------------------------------------------------------
async function fetchProviders() {
  console.log("[1/5] get_providers");
  const providers = await callTool("get_providers", {});
  if (!Array.isArray(providers)) {
    throw new Error("get_providers did not return an array");
  }
  console.log(`    ${providers.length} providers`);
  return providers;
}

async function fetchAllModels(providers) {
  console.log("[2/5] get_all_models per provider");
  const lists = await pMap(providers, async (p) => {
    const models = await callTool("get_all_models", {
      author: p.author,
      limit: 1000,
    });
    return Array.isArray(models) ? models : [];
  });

  // Dedupe by slug across all providers (some authors may overlap).
  const seen = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (m?.slug && !seen.has(m.slug)) seen.set(m.slug, m);
    }
  }
  const all = [...seen.values()].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  console.log(`    ${all.length} unique models across providers`);
  return all;
}

async function fetchModelDetails(models) {
  if (SKIP_DETAIL) {
    console.log("[3/5] get_model — SKIPPED (SKIP_DETAIL=1)");
    return models;
  }
  console.log(`[3/5] get_model per slug (concurrency=${CONCURRENCY})`);
  const detailed = await pMap(models, async (m) => {
    const d = await callTool("get_model", { slug: m.slug });
    if (d?.__error) return { ...m, __detail_error: d.__error };
    if (typeof d !== "object" || d === null) return m;
    // Merge but prefer the rich detail's pricing/capabilities shapes.
    return { ...m, ...d };
  });
  return detailed;
}

async function fetchBenchmarks() {
  console.log("[4/5] get_benchmarks {coding, math, intelligence}");
  const out = {};
  for (const benchmark of ["coding", "math", "intelligence"]) {
    try {
      const r = await callTool("get_benchmarks", { benchmark, limit: 500 });
      out[benchmark] = Array.isArray(r)
        ? r
        : Array.isArray(r?.results)
          ? r.results
          : r;
      console.log(
        `    ${benchmark}: ${
          Array.isArray(out[benchmark]) ? out[benchmark].length : "?"
        } results`,
      );
    } catch (e) {
      console.log(`    ${benchmark}: failed — ${e.message}`);
      out[benchmark] = { __error: String(e?.message || e) };
    }
  }
  return out;
}

async function fetchProviderSlugs(models) {
  if (SKIP_PROVIDER_SLUGS) {
    console.log("[5/5] get_provider_slugs — SKIPPED (SKIP_PROVIDER_SLUGS=1)");
    return {};
  }
  console.log(`[5/5] get_provider_slugs per model`);
  const out = {};
  // Endpoint wants the human-readable model name (e.g. "GLM 4.6"), NOT the
  // slug. Slug queries return {error: "No model found ..."} every time. We
  // dedupe by name within author so we don't waste calls — provider_slugs
  // are name+author-keyed on the upstream side.
  const queries = [];
  const seen = new Set();
  for (const m of models) {
    const name = m.model_name ?? m.name;
    if (!name) continue;
    const key = `${m.author_name ?? m.author ?? ""}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ slug: m.slug, name, author: m.author_name ?? m.author });
  }
  const results = await pMap(
    queries,
    async (q) => {
      const r = await callTool("get_provider_slugs", { query: q.name });
      return [q.slug, r];
    },
    Math.min(CONCURRENCY, 4), // be gentler on this endpoint
  );
  for (const entry of results) {
    if (Array.isArray(entry)) {
      const [slug, r] = entry;
      // Skip "No model found" / error responses.
      if (r && typeof r === "object" && !r.error) {
        out[slug] = r;
      }
    }
  }
  console.log(`    matched ${Object.keys(out).length}/${models.length} models`);
  return out;
}

// ---- Summary ---------------------------------------------------------------
function buildSummary({ providers, models, benchmarks, providerSlugs, fetchedAt }) {
  const priced = models.filter(
    (m) => m?.pricing?.input_per_1m != null || m?.input_per_1m != null,
  );
  const cheapestInput = [...priced]
    .map((m) => ({
      slug: m.slug,
      name: m.model_name ?? m.name ?? null,
      author: m.author_name ?? m.author ?? null,
      input_per_1m: m.pricing?.input_per_1m ?? m.input_per_1m ?? null,
      output_per_1m: m.pricing?.output_per_1m ?? m.output_per_1m ?? null,
      context_length: m.context_length ?? null,
    }))
    .sort((a, b) => (a.input_per_1m ?? Infinity) - (b.input_per_1m ?? Infinity))
    .slice(0, 10);

  const top5 = (Array.isArray(benchmarks?.coding) ? benchmarks.coding : [])
    .slice(0, 5)
    .map((m) => ({
      name: m.model_name ?? m.name ?? m.slug,
      score: m.benchmark_coding ?? m.score ?? null,
      author: m.author_name ?? m.author ?? null,
    }));

  return {
    fetched_at: fetchedAt,
    source: MCP_URL,
    model_count: models.length,
    priced_model_count: priced.length,
    provider_count: providers.length,
    coding_benchmark_top5: top5,
    cheapest_input: cheapestInput,
    provider_slug_match_count: Object.keys(providerSlugs).length,
  };
}

// ---- Main ------------------------------------------------------------------
async function main() {
  console.log(`PricePerToken MCP exhaustive fetcher`);
  console.log(`  MCP URL : ${MCP_URL}`);
  console.log(`  Output  : ${OUT_DIR}`);
  console.log(`  Concurrency : ${CONCURRENCY}`);
  console.log(`  SKIP_DETAIL : ${SKIP_DETAIL}`);
  console.log(`  SKIP_PROVIDER_SLUGS : ${SKIP_PROVIDER_SLUGS}\n`);

  await mkdir(OUT_DIR, { recursive: true });

  console.log("Connecting...");
  const init = await initialize();
  console.log(`  Server : ${init?.serverInfo?.name} v${init?.serverInfo?.version}`);
  console.log(`  Protocol: ${init?.protocolVersion}\n`);

  const providers = await fetchProviders();
  await saveJson("providers.json", providers);

  const lite = await fetchAllModels(providers);
  // Snapshot the lite list before enrichment — consumers that don't need
  // full detail can use this much smaller file.
  await saveJson("models_lite.json", lite);

  const detailed = await fetchModelDetails(lite);
  await saveJson("models.json", detailed);

  const benchmarks = await fetchBenchmarks();
  await saveJson("benchmarks.json", benchmarks);

  const providerSlugs = await fetchProviderSlugs(detailed);
  await saveJson("provider_slugs.json", providerSlugs);

  const fetchedAt = new Date().toISOString();
  const summary = buildSummary({
    providers,
    models: detailed,
    benchmarks,
    providerSlugs,
    fetchedAt,
  });
  await saveJson("summary.json", summary);

  console.log(
    `\nDone. ${detailed.length} models / ${providers.length} providers / ${
      Object.keys(providerSlugs).length
    } provider-slug matches.`,
  );
  console.log(`Files written to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error("\nFATAL:", err?.stack || err?.message || err);
  process.exit(1);
});
