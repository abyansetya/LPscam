# Services Layout

All service files in this directory are still active. They are grouped by runtime role:

- `api/`: response shaping and API-facing composition.
- `indexer/`: SQLite ingest, position history scans, and metric recomputation.
- `onchain/`: live Meteora DLMM/on-chain position readers.
- `shared/`: decoders and pure helpers used by more than one service group.

Avoid putting one-off comparison/debug code here. Use `scripts/` for manual checks.
