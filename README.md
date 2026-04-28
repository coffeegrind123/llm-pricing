# llm-pricing

Daily snapshot of LLM pricing, benchmark and capability data scraped from the
[PricePerToken MCP server](https://api.pricepertoken.com/) and committed to
`data/` as plain JSON arrays (no MCP envelope).

Used as a static lookup table by [openclaude](https://github.com/coffeegrind123/openclaude)
to render accurate session cost in the fuelgauge status line for non-Anthropic
models (DeepSeek, GLM/z-ai, Gemini, GPT-x, NVIDIA NIM, etc.) where the
hardcoded Anthropic pricing tiers wouldn't apply.

## Files in `data/`

| File | Shape | Description |
|---|---|---|
| `providers.json` | `Provider[]` | All authors with model counts and price ranges |
| `models_lite.json` | `Model[]` | Slug + author + name + input/output_per_1m + context_length. Compact (~30 KB). |
| `models.json` | `ModelDetail[]` | Full per-model detail — pricing (input/output/cache_read/cache_write), benchmarks (intelligence/coding/math/mmlu/gpqa/livecodebench), capabilities, modalities. |
| `benchmarks.json` | `{coding: [], math: [], intelligence: []}` | Models ranked per benchmark |
| `provider_slugs.json` | `Record<slug, ProviderSlugs>` | Cross-provider model IDs (Bedrock, Groq, OpenRouter, Together, Fireworks, Cerebras, DeepInfra, SambaNova, Gemini) for each known model |
| `summary.json` | `Summary` | High-level counts, top-5 coding benchmark, cheapest-by-input top 10 |

`models.json` shape:
```jsonc
{
  "slug": "z-ai-glm-4.6",
  "author": "z-ai",
  "author_name": "Z-ai",
  "model": "glm-4.6",
  "model_name": "GLM 4.6",
  "context_length": 204800,
  "pricing": {
    "input_per_1m": 0.6,
    "output_per_1m": 2.2,
    "cache_read_per_1m": 0.11,
    "cache_write_per_1m": null
  },
  "benchmarks": {
    "intelligence": 30.2,
    "coding": 30.2,
    "math": 44.3,
    "mmlu_pro": 78.4,
    "gpqa": 63.2,
    "livecodebench": 56.1
  },
  "capabilities": {
    "supports_vision": false,
    "supports_reasoning": true,
    "supports_tool_calls": true,
    "is_open": true
  },
  "modalities": { "input": ["text"], "output": ["text"] },
  "performance": { "tokens_per_second": 45.0, "time_to_first_token": 0.99 }
}
```

## Refreshing the data

```bash
node fetch-pricing.mjs
```

Pulls every author from `get_providers`, then for each author fans out
`get_all_models(author=<slug>, limit=1000)`, then per-slug calls `get_model`
for the rich detail (cache prices, benchmarks, modalities). Strips MCP
`{content:[{type,text}]}` wrappers, writes plain arrays/objects to `data/`.

Tunables:
- `CONCURRENCY=8` — parallel `get_model` fetches (default 8)
- `SKIP_DETAIL=1` — skip the per-slug enrichment pass (use `models_lite.json` only)
- `SKIP_PROVIDER_SLUGS=1` — skip cross-provider slug enumeration (slowest step)
- `MCP_URL=...` — override MCP endpoint
- `--out <dir>` — output directory (default `./data/`)

## License

MIT.
