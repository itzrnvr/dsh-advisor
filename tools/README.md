# tools/ — live-verification diagnostics

Read-only scripts this project uses to verify advisor behavior against REAL
session data (never through the plugin's own claims):

| Script | Answers |
|---|---|
| `extract-asar-file.cjs` / `extract-asar-tree.cjs` | Pull one file / the file list out of the desktop `app.asar` — the source of truth for HOST semantics (agent-loop `turn()`/`preStep` ordering, chat `turnTail`/`tailData` visibility, `isVisibleChatNode`). |
| `seed-gui-session.cjs` | Seed a throwaway session for GUI verification runs. |
| `e2e-notes-derivation.cjs` | Run the BUILT notes derivation (`lib/seed.js`) over a real multi-frame zstd session log — the acceptance check behind the 0.6.44 ghost-shape fix. |
| `cadence-forensics.cjs` | Steps/turns/notes per session: steps-between-notes histogram, zero-step pairs, era slicing by timestamp. Produced the "notes burst at yield" diagnosis (0.6.48) and the "display-at-boundary wall" diagnosis (0.6.49). |
| `message-order.cjs` | The ordered message list (turn/step boundaries, user/agent/note rows with seq + IST time) — attribution audits. |

## Where the host evidence lives

These scripts decode `~/.dsh/sessions/**/session.v4.jsonl.zstd` (multi-frame
zstd, magic `28 B5 2F FD`). The EXTRACTED HOST BUNDLES they are cross-checked
against (`dsh-agent-loop-lib-index.js`, `dsh-client-ui-chat-client.js`,
`dsh-client-ui-conversation-client.js`, …) live in the operator's
`ds-harness/tools/extracted-host/` directory — OUTSIDE this repo. Re-extract
them with the two `extract-asar-*.cjs` scripts from the installed desktop
`app.asar` whenever host behavior must be re-verified.

## Recorded host facts (do not re-derive, do not re-propose)

- **The turn-tail node exists only after `turn/end`.** `tailData()` in the
  shipped chat bundle returns null while the turn is open, so
  `conversation.chat.turnTail` NEVER renders for a running turn. A plugin
  "openTurn fallback" on that seat is dead code (verified 2026-11-04 after a
  restart cycle was already spent on the idea — see the HOST FACT block in
  `src/seed.ts`).
- **`agent/pre-step` is an awaited waterfall** that runs AFTER `inbox.claim`
  and BEFORE `step/start` + the step's model call; a steer inserted during a
  pre-step hold is claimed one step late, while a `session.append` during the
  hold joins the held step's own request (`buildRequest` derives from the
  surface). This is why the 0.6.48 gate commits while holding.
- **Advisor messages never render as chat bubbles** — the host's
  `isVisibleChatNode` hides producer-kind context nodes; the tails (and the
  former strip) are the only surfaces.
