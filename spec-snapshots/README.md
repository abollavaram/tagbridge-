# Pinned protocol schema snapshots

Vendored, not fetched. The acceptance criterion for the agent-native layer is
that the manifest "validates against the current spec snapshot", and a
validation that reaches the network is not a test — it fails when a CDN is
slow and passes when an upstream file changes underneath it. These are the
exact bytes the manifest was built against, and `pnpm test` validates against
them offline.

Both are living specs. Pinning is what makes a version claim checkable: when
either moves, the diff shows up here as a deliberate update rather than as a
silent behaviour change.

## Universal Commerce Protocol

- Source: https://github.com/universal-commerce-protocol/ucp
- Commit: `1d39948355c5f97523c47abade9550b872e75df3`
- Path: `source/schemas`
- Protocol version served: 2026-08-25

## Agentic Commerce Protocol

- Source: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
- Commit: `7fdd78df677a94dce04c770644b0fbbb1401272b`
- Path: `spec/2026-04-17/json-schema/schema.agentic_checkout.json`
- Protocol version served: 2026-04-17
