# Sparky MCP contract

Source of truth for the data shapes, commands, and routes shared by `sparky-mcp` (server) and the Sparky app. Scope: **Mind** and **Memory** only. No tags, no file attachments (links only).

## Architecture in one paragraph

The app owns the data. It uploads a **mirror** (read-only copy of all Minds and Memories) to the server after every change. MCP read tools answer from the mirror. MCP write tools insert **commands** into a queue; the app claims them, applies them through `MemoryService` / `MindService`, reports a result, and re-uploads the mirror.

```
AI ──MCP──▶ server ◀──HTTPS──▶ app
            ├─ mirror   (PUT /api/mirror)
            └─ commands (GET /api/commands, POST /api/commands/:id/result)
```

## Conventions

- JSON, UTF-8, camelCase.
- IDs are UUID strings (lowercase). Entity IDs are the app's own IDs.
- Dates are ISO 8601 UTC with milliseconds (`2026-10-02T12:00:00.000Z`). `updatedAt` is the entity **version**.
- `null` in a patch clears a field; an absent key leaves it unchanged.
- App routes require `Authorization: Bearer <API_TOKEN>`.

## Entities

### Mind

```jsonc
{
  "id": "uuid",
  "name": "Work",
  "colorHex": "#F97316",      // nullable
  "iconName": "briefcase",    // nullable, SF Symbol name
  "sortOrder": 1,
  "isDefault": false,
  "parentId": "uuid|null",
  "updatedAt": "date"
}
```

### Memory

```jsonc
{
  "id": "uuid",
  "title": "Buy milk",
  "note": "string|null",
  "status": "active|completed",
  "isPinned": false,
  "priority": 0,                       // nullable int
  "dueDate": "date|null",
  "mindId": "uuid|null",               // null = Inbox
  "completedAt": "date|null",
  "completedDates": ["date"],          // per-occurrence completions for recurring memories
  "autoCompleteOnChecklistCompletion": false,
  "checklist": [
    { "id": "uuid", "title": "Milk", "detail": "", "isCompleted": false, "sortOrder": 0 }
  ],
  "schedule": {                        // nullable
    "fireDate": "date",
    "isAllDay": false,
    "timeZone": "America/Sao_Paulo",
    "isActive": true,
    "recurrence": {                    // nullable
      "frequency": "minutely|hourly|daily|weekly|monthly|yearly",
      "interval": 1,
      "weekdays": ["mon", "wed"],     // weekly only; sun|mon|tue|wed|thu|fri|sat
      "endDate": "date|null",
      "occurrenceCount": "int|null"   // mutually exclusive with endDate
    },
    "focus": {                         // nullable; configuration only, sessions are not controllable
      "enabled": true,
      "workMinutes": 25,
      "shortBreakMinutes": 5,
      "longBreakMinutes": 15,
      "pomodorosUntilLongBreak": 4,
      "autoContinue": true
    }
  },
  "location": {                        // nullable
    "name": "Home",
    "latitude": -23.55,
    "longitude": -46.63,
    "radiusMeters": 200,
    "event": "onEntry|onExit",
    "isActive": true
  },
  "links": [ { "url": "https://example.com", "title": "string|null" } ],
  "createdAt": "date",
  "updatedAt": "date"
}
```

App mapping notes: `note` ↔ `Memory.body`; `schedule.recurrence.weekdays` ↔ `ScheduleConfig.weekdayMask` (bit `1 << n`, Sunday = 1); `radiusMeters` ↔ `LocationConfig.radius`; `completedDates` ↔ `MemoryCompletionDate`.

## Mirror

`PUT /api/mirror` — full replace, idempotent.

```jsonc
{ "syncedAt": "date", "minds": [Mind], "memories": [Memory] }
```

The app sends it after startup, after applying commands, and (debounced ~2s) after any local change. MCP read responses include `syncedAt`. If the mirror is older than 24h the server adds `"stale": true` to read results.

## Commands

A command is one write operation requested by the AI.

```jsonc
{
  "id": "uuid",                 // idempotency key
  "type": "memory.update",
  "targetId": "uuid|null",      // null for *.create
  "baseVersion": "date|null",   // updatedAt the AI saw; required for update/setStatus/toggleCheckItem/delete
  "payload": { },
  "createdAt": "date"
}
```

| type | payload |
| --- | --- |
| `memory.create` | Memory fields except `id`, `status`, `completedAt`, `completedDates`, `createdAt`, `updatedAt`. `mindId` already resolved by the server. |
| `memory.update` | `{ "patch": { ...any Memory field except id/createdAt/updatedAt } }`. `checklist`, when present, **replaces** the whole list; items may carry an existing `id` to keep identity. |
| `memory.setStatus` | `{ "status": "active|completed", "occurrenceDate": "date|null" }`. `occurrenceDate` marks one occurrence of a recurring memory. |
| `memory.toggleCheckItem` | `{ "itemId": "uuid", "occurrenceDate": "date|null" }` |
| `memory.delete` | `{}` |
| `mind.create` | Mind fields except `id`, `isDefault`, `updatedAt`. |
| `mind.update` | `{ "patch": { name, colorHex, iconName, sortOrder, parentId } }` |
| `mind.delete` | `{}`. Deletes the Mind **and all its child Minds** (recursive). Memories in any deleted Mind become Inbox memories. |

### Lifecycle

```
pending ─▶ claimed ─▶ done
                  ├─▶ failed     validation or execution error
                  └─▶ conflict   entity changed since baseVersion
```

- Applied strictly in `createdAt` order, one at a time.
- **Idempotency:** the app remembers applied command IDs; a re-delivered command is not re-executed, its stored result is re-reported.
- **Conflict:** for commands with `baseVersion`, if `entity.updatedAt != baseVersion` the app does not apply and reports `conflict` with the current entity. `*.create` never conflicts.
- **Stale claims:** a command `claimed` for more than 5 minutes returns to `pending`.
- **Retention:** finished commands are deleted after 30 days.
- Every successful command stamps `updatedAt` on the touched Memory/Mind.

## App API

| Route | Description |
| --- | --- |
| `PUT /api/mirror` | Replace the mirror. Returns `{ "ok": true }`. |
| `GET /api/commands?limit=20` | Atomically claims and returns pending commands (oldest first): `{ "commands": [Command] }`. |
| `POST /api/commands/:id/result` | Body `{ "status": "done|failed|conflict", "result": object, "error": "string" }`. `result` for `done` holds the affected entity (`{ "memory": Memory }` / `{ "mind": Mind }`) or `{ "deletedId": "uuid" }`; for `conflict` it holds the current entity. Idempotent. |

## MCP tools

Read (answered from the mirror, no queue):

| Tool | Notes |
| --- | --- |
| `get_current_time` | Server time and the user's time zone. |
| `list_minds` | Mind tree: id, name, color, icon, parentId. |
| `list_memories` | Filters: `mind` (name or id), `status`, `pinned`, `dueFrom`, `dueTo`, `updatedFrom`, `updatedTo` (inclusive `updatedAt` range), `query` (title/note/checklist text), `limit` (default 50). Summaries are newest `updatedAt` first; equal timestamps break by id ascending. |
| `get_memory` | Full Memory by id. |
| `get_command_status` | State and result of a command by id. |

Write (each returns `{ commandId, status: "pending" }` immediately):

| Tool | Command |
| --- | --- |
| `create_memory` | `memory.create` (accepts `mind` by name) |
| `update_memory` | `memory.update` (`baseVersion` filled from the mirror automatically; the AI may override) |
| `set_memory_status` | `memory.setStatus` |
| `toggle_check_item` | `memory.toggleCheckItem` |
| `delete_memory` | `memory.delete` — requires `confirm: true` |
| `create_mind` | `mind.create` |
| `update_mind` | `mind.update` |
| `delete_mind` | `mind.delete` — requires `confirm: true`; description states that child Minds are deleted too and memories move to the Inbox |

13 tools in total. Write tools reject unknown `mind` names with the list of valid ones, and reject targets that do not exist in the mirror.
