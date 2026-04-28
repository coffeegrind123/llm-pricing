#!/usr/bin/env node
/**
 * fetch-pricing.mjs — Connects to the Price Per Token MCP server,
 * calls every available tool, and writes the results as JSON files.
 *
 * Usage:  node fetch-pricing.mjs [--out data/]
 *         MCP_URL=https://api.pricepertoken.com/mcp/mcp node fetch-pricing.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const MCP_URL = process.env.MCP_URL || "https://api.pricepertoken.com/mcp/mcp";
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : resolve(import.meta.dirname || ".", "data");

// ---- JSON-RPC helpers --------------------------------------------------------

let nextId = 1;

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: nextId++, method };
  if (params) body.params = params;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 400)}`);
  }

  const json = await res.json();
  if (json.error) throw new Error(`RPC error on ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function notify(method, params) {
  const body = { jsonrpc: "2.0", method };
  if (params) body.params = params;
  await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- MCP lifecycle -----------------------------------------------------------

async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "pricepertoken-fetcher", version: "1.0.0" },
  });
  await notify("notifications/initialized", {});
  return result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  // MCP tools return { content: [{ type: "text", text: "..." }] }
  return result;
}

// ---- Save helper -------------------------------------------------------------

async function saveJson(filename, data) {
  const path = resolve(OUT_DIR, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`  -> ${filename} (${JSON.stringify(data).length.toLocaleString()} bytes)`);
}

// ---- Tool wrappers -----------------------------------------------------------

async function fetchAllModels() {
  console.log("[1/7] get_all_models...");
  const result = await callTool("get_all_models", {});
  await saveJson("all_models.json", result);
  return result;
}

async function fetchProviders() {
  console.log("[2/7] get_providers...");
  const result = await callTool("get_providers", {});
  await saveJson("providers.json", result);
  return result;
}

async function fetchProviderSlugs() {
  console.log("[3/7] get_provider_slugs...");
  const result = await callTool("get_provider_slugs", {});
  await saveJson("provider_slugs.json", result);
  return result;
}

async function fetchBenchmarks() {
  console.log("[4/7] get_benchmarks (coding)...");
  const coding = await callTool("get_benchmarks", { benchmark: "coding" });
  await saveJson("benchmarks_coding.json", coding);

  console.log("[5/7] get_benchmarks (math)...");
  const math = await callTool("get_benchmarks", { benchmark: "math" });
  await saveJson("benchmarks_math.json", math);

  console.log("[6/7] get_benchmarks (intelligence)...");
  const intelligence = await callTool("get_benchmarks", { benchmark: "intelligence" });
  await saveJson("benchmarks_intelligence.json", intelligence);

  return { coding, math, intelligence };
}

async function fetchSummary() {
  console.log("[7/7] Writing summary...");
  const modelsRaw = await readJson("all_models.json");
  const providersRaw = await readJson("providers.json");
  const codingRaw = await readJson("benchmarks_coding.json");
  const slugsRaw = await readJson("provider_slugs.json");

  // Parse text content out of MCP tool results
  const parse = (raw) => {
    try {
      const content = raw?.content?.[0]?.text;
      return content ? JSON.parse(content) : raw;
    } catch {
      return raw;
    }
  };

  const models = parse(modelsRaw);
  const providers = parse(providersRaw);
  const coding = parse(codingRaw);
  const slugs = parse(slugsRaw);

  const summary = {
    fetched_at: new Date().toISOString(),
    model_count: Array.isArray(models) ? models.length : Array.isArray(models?.models) ? models.models.length : "unknown",
    provider_count: Array.isArray(providers) ? providers.length : Array.isArray(providers?.providers) ? providers.providers.length : "unknown",
    coding_benchmark_top5: Array.isArray(coding?.results)
      ? coding.results.slice(0, 5).map((m) => ({
          name: m.model_name || m.name || m.slug,
          score: m.benchmark_coding,
          author: m.author_name,
        }))
      : Array.isArray(coding)
        ? coding.slice(0, 5).map((m) => m.model_name || m.name || m.slug || m.model || m.id)
        : [],
    cheapest_input: Array.isArray(models)
      ? models
          .filter((m) => m.input_per_1m != null)
          .sort((a, b) => (a.input_per_1m ?? Infinity) - (b.input_per_1m ?? Infinity))
          .slice(0, 10)
          .map((m) => ({
            slug: m.slug,
            name: m.model_name || m.name,
            author: m.author_name,
            input_per_1m: m.input_per_1m,
            output_per_1m: m.output_per_1m,
            context_length: m.context_length,
          }))
      : [],
    fastest_ttft: Array.isArray(models)
      ? models
          .filter((m) => m.time_to_first_token != null && m.time_to_first_token > 0)
          .sort((a, b) => (a.time_to_first_token ?? Infinity) - (b.time_to_first_token ?? Infinity))
          .slice(0, 10)
          .map((m) => ({
            slug: m.slug,
            name: m.model_name || m.name,
            time_to_first_token: m.time_to_first_token,
            tokens_per_second: m.tokens_per_second,
          }))
      : [],
    models_with_vision: Array.isArray(models)
      ? models.filter((m) => m.supports_vision).length
      : "unknown",
    models_with_reasoning: Array.isArray(models)
      ? models.filter((m) => m.supports_reasoning).length
      : "unknown",
    provider_slugs_count: typeof slugs === "object" ? Object.keys(slugs).length : "unknown",
  };

  await saveJson("summary.json", summary);
  return summary;
}

async function readJson(filename) {
  const path = resolve(OUT_DIR, filename);
  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf-8"));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- Main --------------------------------------------------------------------

async function main() {
  console.log(`Price Per Token MCP fetcher`);
  console.log(`  MCP URL : ${MCP_URL}`);
  console.log(`  Output  : ${OUT_DIR}\n`);

  await mkdir(OUT_DIR, { recursive: true });

  console.log("Connecting...");
  const init = await initialize();
  console.log(`  Server : ${init?.serverInfo?.name} v${init?.serverInfo?.version}`);
  console.log(`  Protocol: ${init?.protocolVersion}\n`);

  await fetchAllModels();
  await fetchProviders();
  await fetchProviderSlugs();
  await fetchBenchmarks();
  const summary = await fetchSummary();

  console.log(`\nDone. ${summary.model_count} models, ${summary.provider_count} providers.`);
  console.log(`Files written to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
