# Sparky MCP and local integration test matrix

## Scope and execution

This battery validates the 13 MCP tools, SQLite mirror/queue, Swift command executor, mirror builder and transport. Local suites use temporary storage and synthetic configuration. Live scenarios modify only entities created by their run and keep notification/location triggers inactive.

UI, actual focus sessions, notification delivery, physical geofence transitions, attachment formats other than links, multi-device synchronization and operating-system lifecycle behavior are outside this battery. Configuration persistence is not proof that a notification or geofence fires.

## Coverage

| Area | Reusable local coverage | Live coverage |
| --- | --- | --- |
| Tool discovery | Exact 13-tool inventory via MCP Client/InMemoryTransport | Connector calls to all 13 tools |
| Minds | Defaults, metadata, hierarchy, missing parent, cycles, detach/reparent, recursive deletion, Inbox transfer | Root/child/grandchild, metadata, cycle failure, detach/reparent, tree deletion, Inbox transfer |
| Memory CRUD | Minimal/complete create, independent SwiftData fetch, update omission/null, status, metadata, delete/attachments | Minimal/complete create, get, field preservation, null/empty clear, move, complete/reopen/delete |
| Checklist | Generated IDs, identity, edits/order/replacement, duplicates/missing IDs, true/false auto-complete, recurring occurrence toggles | Generated IDs, toggle, edit/order/replacement, duplicates, missing ID, true/false auto-complete |
| Queries | Title/note/checklist/detail case-insensitive match, combined filters, status/pin, Mind name/UUID, inclusive date range, limit, empty | Title/note/checklist, combined filters, status/pin, Mind name/UUID, inclusive dates, limit, empty |
| Schedule | Six frequencies, interval, weekdays, count/date endings, all-day, timezone, focus fields, UTC dates | Weekly complete record; six frequency updates with date ending; independent occurrence completion/reopen |
| Calendar boundaries | Offset conversion at month/year/leap-day boundaries; strict UTC millisecond codec; existing calendar occurrence tests | Leap-day input normalized into next month UTC |
| Location/links/focus | Create/update/preserve/remove; coordinate/radius/timezone/URL/duration validation | Complete record roundtrip and removal; invalid coordinates/timezone |
| Validation | Empty/whitespace titles, UUID/date errors, missing targets, invalid recurrence combinations, unknown fields, confirmation required | Empty title, missing Mind/Memory/item, invalid coordinates/timezone/recurrence |
| Queue | Ordering including ties, claim batching, stale five-minute claims, terminal states, repeated report, 30-day retention, malformed API input | Command status to terminal followed by mirror confirmation; stale baseVersion conflict |
| Executor recovery | Same command redelivery/reopened journal, pending reports, interrupted receipts, corrupted/unwritable journal, 30-day/500-record history | Deliberately not fault-injected on live connection |
| Transport | Synthetic URLProtocol: success routes/methods/bodies, 401, 500/detail, malformed JSON, network failure, timeout, absent injected token | Existing connector and active app only |

## Reproduction

From `sparky-mcp`: `bun run typecheck` and `bun test`. The remote contracts wrapper runs 27 cases in a separate process with a temporary `SPARKY_MCP_HOME` and `DATA_DIR` before server imports. The outer suite has one aggregate failure if any nested regression fails; do not count it as another distinct product defect.

From `sparky`: `xcodebuild -scheme sparky -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.0' -only-testing:sparkyTests test`. This excludes execution of `sparkyUITests`; Xcode may still compile that target. Existing tests are reused. The Mac scheme has no configured test target, so only its build is validated.

Builds: `xcodebuild -scheme sparky -destination 'generic/platform=iOS Simulator' build` and `xcodebuild -scheme sparkyMac -destination 'platform=macOS' build`.

## Live runner

`scripts/mcp-e2e.mjs` exports `runLiveBattery(transport, state, checkpoint)`. Supply a connector transport `(toolName, arguments) => Promise<McpToolResult>`, `state = { prefix: 'E2E-<timestamp>-<runId>' }` and a checkpoint callback that durably stores the run state. It does not load credentials or open the app. Use the existing authorized connector. The default polling interval is five seconds and deadline 120 seconds per write.

The state contains case evidence, durations, command IDs and owned entity IDs. Resume cleanup with those exact IDs after interruption. Do not blindly restart a partly finished suite: completed functional steps are not an idempotent workflow. Resume state is used for ownership tracking and previously created setup entities, not to deduplicate all scenario steps.

`terminal-matched` means the command reached its expected terminal state. A separate mirror assertion is required for mutation success. Negative cases intentionally expect `failed` or `conflict`. The run passes only if all mirror/validation assertions pass, no case is blocked and `cleanup.status` is `passed`.

Unresolved commands prevent cleanup approval, because queued creations could be applied later. Never claim successful cleanup based only on an empty current mirror when commands remain pending.
