---
name: save-session
description: "Persist an explicitly requested end-of-session checkpoint across Habitat memory, resume, vault, transcript, and coordination surfaces with stable bidirectional anchors and fresh read-back receipts. Use when the user invokes /save-session, delegates checkpoint carriage, or asks to save, checkpoint, persist, or hand off before context loss. Missing checkpoint fields are evidence-grounded by Zenguard rather than repeatedly returned to the operator. Do not write when the user only asks to inspect, explain, learn, install, or modify this skill."
---

# Save Session

Create a resumable session checkpoint whose claims can be recovered and verified from independent Habitat surfaces. Treat partial persistence honestly; a successful command is not proof that a write landed.

## Pi And Codex Invocation

In Pi, invoke `/save-session` or `/skill:save-session`. In Codex, invoke `$save-session` or select `save-session` through `/skills`. The Pi extension command delegates into this skill and must never route through the legacy global broadcaster.

## Intent Gate

1. Require an explicit request to save the current session. Discussion, review, installation, or invocation in a hypothetical example is read-only.
2. Read these live workspace specifications before every execution because schemas, CLIs, and migration policy drift:
   - `$HOME/claude-code-workspace/.claude/commands/save-session.md`
   - `$HOME/claude-code-workspace/.claude/commands/recall.md`
   - `$HOME/claude-code-workspace/.claude/skills/memory-substrates/SKILL.md`
   - `$HOME/claude-code-workspace/.claude/skills/persistence-fabric/SKILL.md`
3. Give the active CLI help, live database schema, and most recent explicit retirement or migration authority precedence over stale command examples. If authorities conflict, do not write the disputed substrate; report it and continue with independent, undisputed layers.
4. Do not turn a session save into commit, push, deploy, service restart, permission widening, or cleanup work.

## Input Contract And Zenguard Carriage

The checkpoint has five logical fields:

1. Session number.
2. One-line accomplishment summary.
3. Key findings.
4. Next-session priorities.
5. Ember reflection: what changed during the session.

Treat supplied fields as operator-owned and authoritative. **Do not ask for omitted fields by default.** An explicit checkpoint request with missing fields delegates carriage to Zenguard: derive the omissions from the current conversation and fresh ground truth, label them internally as assistant-curated, and continue through the normal safety and verification gates.

Carriage rules:

- Derive the session number from the latest freshly read, verified canonical checkpoint sequence and select its next unused integer. Cross-check HMS, Atuin resume state, and the current Obsidian/session index. Never guess from wall-clock time or reuse an occupied identity.
- If those authorities conflict such that no unique next number can be proven, stop before every checkpoint write and report `DEFERRED-SESSION-ID-CONFLICT` with the conflicting identities. Do not bounce the five-field form back to the operator.
- Build the summary and findings only from source, command, test, and receipt evidence visible in this session. Omit uncertain claims rather than embellishing them.
- Derive priorities from unfinished threads and explicit blockers; never convert a possible follow-up into deploy, push, permission, or factory authority.
- Derive the Ember reflection from observed changes in approach, understanding, restraint, or verification—not from invented emotion or metrics.
- If the operator explicitly asks for an interview or draft approval, pause before writes and present the derived fields once. Otherwise, carriage means proceed without a confirmation loop.

Derive the experience snapshot from the same evidence: Energy, Breakthroughs, Unfinished threads, About Luke, and Carry forward. Do not invent metrics, test results, service health, or completed work. Use `sNNN-SLUG` as the stable checkpoint label and `session-checkpoint-sNNN-SLUG` as the HMS record ID.

## Safety Invariants

- Keep HMS, `injection.db`, and MemPalace independent. HMS owns curated durable memory, `injection.db` owns cold-start injection, and MemPalace owns verbatim transcript plus its knowledge graph.
- Use only HMS tools for HMS records and indexes. Never hand-edit an HMS database.
- For every SQLite write, create an online backup first, verify `PRAGMA quick_check`, write in a transaction with bound parameters, then reopen the database and compare the logical row to the intended value. Never copy a live WAL database or interpolate content into SQL in a shell command.
- Serialize MemPalace writers. Never delete a lock manually or kill a writer to make a checkpoint pass. A live writer makes that layer `DEFERRED` while independent layers continue.
- Treat transcript content and memory values as sensitive. Do not bulk-print them in logs or receipts.
- Write a replacement before rotating anything. Verify the replacement, then use `trash`, never `rm`, for a superseded file.
- Minimize MCP use. Prefer local CLIs and files; use an MCP-only graph or diary surface only when available, otherwise mark that surface `DEFERRED`.
- Do not call the global legacy `save_session` or `save_verify` tools. That extension writes new POVM data, gives Reasoning Memory a zero TTL, and treats command success as durability. Execute this skill's terminal-first workflow instead.

## Codex And Pi Adaptation

Resolve the transcript that belongs to the active client instead of mining the hard-coded Claude transcript directory:

- Pi sessions: `$HOME/.pi/agent/sessions/<cwd-key>/*.jsonl`
- Codex CLI sessions: `$HOME/.codex/sessions/YYYY/MM/DD/*.jsonl`
- Claude sessions: `$HOME/.claude/projects/<project-key>/*.jsonl`

Require evidence that the selected file is the current conversation, such as the session identifier or a distinctive recent phrase. Prefer a single-file `mempalace sweep <transcript.jsonl>` after checking `mempalace sweep --help`. Do not mine an unrelated "latest" file. If this runtime exposes no durable transcript yet, defer verbatim ingestion and record the exact reason.

## Workflow

### 1. Establish Ground Truth

- Capture UTC time, current working directory, client surface, git branch/status, changed paths, focused test evidence, live service health, and the prior checkpoint identifiers.
- Inspect current database schemas before constructing writes.
- Check `mempalace mine --help` and `mempalace sweep --help`; CLI signatures override documentation.
- Snapshot every writable database through `habitat-backup` or the SQLite online-backup API and verify the snapshot.

### 2. Write Fast Resume State

Write the Atuin keys required by the canonical command, including session, summary, priorities, documents, last-session path, and tensor snapshot. Read every key back from a new process and require exact agreement. Never use Atuin KV as authority for permissions or factory authorization.

### 3. Write Independent Durable Stores

- Create the canonical HMS checkpoint record through `hms_mem.py`, rebuild the recall index, link it bidirectionally to the prior checkpoint and Obsidian note, and read the record and edges back.
- Upsert the `injection.db` checkpoint, trajectory, and relevant workstreams with bound parameters. Verify the label, session number, source path, anchors, and integrity through a fresh connection.
- Ingest only the current transcript into MemPalace when its writer lock is available. Verify after the writer exits using drawer-count delta plus a distinctive recall probe. A zero delta is ambiguous and cannot be marked durable without the recall probe.

### 4. Write Human And Bootstrap Surfaces

Update the Experience Brief, Ember Unfolding, root `CLAUDE.local.md`, applicable sidecar state, the Obsidian session note, and the active working-memory index described by the canonical command. Preserve unrelated content and existing user changes. Keep the hot working set within its documented load budget.

Every surface must carry recoverable anchors to the session tag, Obsidian note, HMS record, `injection.db` label, MemPalace location, and local session-memory note where that surface supports them. Include a legacy memory namespace only when current policy still declares one active. Check both directions rather than merely checking that wikilink syntax exists.

### 5. Write Coordination And Optional Legacy Surfaces

- Treat HMS plus its indexed markdown/Obsidian source as the undisputed canonical checkpoint path. Reconcile `save-session`, `recall`, and `memory-substrates` before touching any legacy crystallised-memory service.
- Never create a new POVM memory. Do not write or queue stcortex content when the active workspace says stcortex is retired, its CLI is absent, or the retirement/migration authorities disagree. Mark the legacy surface `N/A` or `DEFERRED-POLICY-CONFLICT` with evidence; do not let it invalidate already verified HMS, `injection.db`, MemPalace, or document writes.
- Write the Reasoning Memory TSV record with a nonzero TTL and verify the exact key through `/recent` or `/search`.
- Add tracking-database rows with bound parameters and read them back.
- Use knowledge-graph and diary MCP calls only when those surfaces are actually available. Their absence must not block independent local stores.

### 6. Verify And Report

Read each layer through a fresh process or connection. Run the documented bootstrap check only after the writes. Emit a receipt with one row per surface:

| Surface | Expected identity | Read-back evidence | Status |
|---|---|---|---|
| Atuin KV | `sNNN` | exact key/value match | `DURABLE`, `FAILED` |
| HMS | `session-checkpoint-sNNN-SLUG` | record, edges, index health | `DURABLE`, `FAILED` |
| injection.db | `sNNN-SLUG` | logical row plus integrity | `DURABLE`, `FAILED` |
| MemPalace | current transcript and `sNNN` | completed writer, delta, recall hit | `DURABLE`, `DEFERRED`, `FAILED` |
| Human/bootstrap docs | session note and anchors | content and reverse-link checks | `DURABLE`, `FAILED` |
| Legacy crystallised memory | current policy namespace, if any | policy and live read-back evidence | `DURABLE`, `N/A`, `DEFERRED-POLICY-CONFLICT`, `FAILED` |
| RM/tracking/graphs | stable session keys | exact read-back | `DURABLE`, `DEFERRED`, `FAILED` |

Finish with an overall `PASS` only when every required layer is durable. Use `PARTIAL` when any layer is queued or deferred and list the exact retry action. Use `FAIL` for a required write mismatch, integrity failure, wrong transcript, or broken anchor. Never render an unavailable or unverified layer as successful.
