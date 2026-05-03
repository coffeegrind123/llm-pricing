# llm-pricing

Daily snapshot of LLM pricing pulled from
[aipricing.guru](https://www.aipricing.guru/api/pricing.json) and committed to
`data/` as plain JSON.

Used as a static lookup table by [openclaude](https://github.com/coffeegrind123/openclaude)
to render accurate session cost in the fuelgauge status line for non-Anthropic
models (DeepSeek, Gemini, GPT-x, Grok, Mistral, etc.) where the hardcoded
Anthropic pricing tiers wouldn't apply.

## Files in `data/`

| File | Shape | Description |
|---|---|---|
| `pricing.json` | `{lastUpdated, scrapedAt, modelCount, providerCount, models[]}` | Full upstream payload, models sorted by id for deterministic diffs. |
| `models.json` | `Model[]` | Just the `models` array — what openclaude reads via the GitHub raw URL. |
| `summary.json` | `Summary` | Provenance + counts (`fetched_at`, `source`, `upstream_last_updated`, `model_count`, `provider_count`, `models_per_provider`). |

`Model` shape (mirrors aipricing.guru's response 1:1):
```jsonc
{
  "id": "claude-sonnet-4.6",
  "name": "Claude Sonnet 4.6",
  "family": "Claude 4.6",
  "provider": "anthropic",
  "pricing": {
    "inputPerM": 3,
    "cachedInputPerM": 0.3,
    "outputPerM": 15
  },
  "status": "active"
}
```

`pricing.cachedInputPerM` is optional — providers that don't expose a cache-read
rate omit the field entirely. `status` is one of `active`, `legacy`, `preview`.

## Refreshing the data

```bash
node fetch-pricing.mjs
```

Single HTTP GET against the upstream API; writes the three files above.

Tunables:
- `API_URL=...` — override upstream endpoint (default `https://www.aipricing.guru/api/pricing.json`)
- `--out <dir>` — output directory (default `./data/`)

The GitHub Action at `.github/workflows/fetch-llm-pricing.yml` runs this daily
at 06:00 UTC and commits any changes back to `main`.

## License

MIT.
