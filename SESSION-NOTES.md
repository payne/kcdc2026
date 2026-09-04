# KCDC 2026 data-build session notes

Recap of this session's work, for picking up later.

## What exists on disk

- `/home/mpayne/Work/kcdc/kcdc-2026-sessions.json` — all 207 KCDC 2026 sessions
  (event runs **Sept 9–11, 2026**; today is 2026-09-04, so the event hasn't happened yet).
- `/home/mpayne/Work/kcdc/youtubes.json` — 90 YouTube matches for 65 of 147 speakers
  (see "Coverage gap" below for how it grew from the original 72/53), joined to the
  sessions file.
- `/home/mpayne/Work/kcdc/complete_youtubes.py` — CLI to keep searching for more matches.
- `/home/mpayne/Work/kcdc/build_db.py` — builds `kcdc.db`, a SQLite database joining
  both JSON files (see below).
- `/home/mpayne/Work/kcdc/kcdc.db` — the built SQLite database (regenerate anytime
  with `python3 build_db.py --force`; not committed yet, repo has no commits at all).

## How `kcdc-2026-sessions.json` was built

- The public agenda page (`https://www.kcdc.info/agenda`) is a Squarespace page with no
  session data in the HTML — it just links out to Sessionize.
- The Sessionize app at `https://kcdc2026.sessionize.com/` is a Vue SPA that also renders
  no data server-side, but it hits a plain JSON API:
  `https://kcdc2026.sessionize.com/api/schedule` — returns `{sessions, speakers, questions,
  categories, rooms}`.
- Joined `sessions[].speakers` (an array of speaker GUIDs) against `speakers[].fullName`,
  and `sessions[].roomId` against `rooms[].name`, then flattened into one JSON array
  with: `id, title, description, startsAt, endsAt, room, speakers[], status,
  isServiceSession, isPlenumSession, liveUrl, recordingUrl`.
- Confirmed `recordingUrl`/`liveUrl` are `null` on every session (event hasn't happened,
  no recordings exist yet) — this is why `youtubes.json` had to look at *prior* talks
  instead of actual 2026 recordings.
- 207 total sessions; 203 are real talks/workshops (`isServiceSession: false`); 147
  unique speakers.

## How `youtubes.json` was built

User was asked (via AskUserQuestion) what a "matching YouTube video" should mean given
the event hasn't happened yet. Chose: **search YouTube for prior talks by the same
speakers on the same/similar topics**, as a stand-in until real 2026 recordings exist.

Process:
1. Split the 147 speakers into 10 batches of ~14–15 (`speaker_batch_0.json` ...
   `speaker_batch_9.json`, in the session's scratchpad dir — these are temp files, not
   part of the deliverable).
2. Launched **10 parallel fork agents**, each given one batch, instructed to WebSearch
   each speaker + session title, verify real youtube.com URLs (no fabrication), and
   write a flat JSON array of matches to `youtube_matches_N.json`.
3. Merged all 10 batch outputs into the final `/home/mpayne/Work/kcdc/youtubes.json`.

**Known wrinkle:** batch 8's agent deviated from instructions — instead of writing only
its flat matches file, it wrote its own premature/partial version of
`/home/mpayne/Work/kcdc/youtubes.json` directly (only its own 13 matches, different
envelope). This was overwritten with the correct full merge of all 10 batches. Worth
flagging as a subagent-instruction-following issue if useful later.

### `youtubes.json` schema

```json
{
  "event": "KCDC 2026",
  "joinsWith": "kcdc-2026-sessions.json",
  "joinKey": "matches[].sessionId == sessions[].id in kcdc-2026-sessions.json",
  "generatedAt": "2026-09-04",
  "note": "...",
  "matchTypeLegend": { "same-title-prior-year": "...", "same-speaker-similar-topic": "...", "same-speaker-other-talk": "..." },
  "totalSpeakers": 147,
  "speakersWithAtLeastOneMatch": 53,
  "sessionsWithAtLeastOneMatch": 60,
  "matchCount": 72,
  "speakersSearchedWithNoMatchFound": [ "...94 names..." ],
  "matches": [
    {
      "sessionId": "1141971",
      "sessionTitle": "Above the Cloud: Building Data Centers in Space",
      "speaker": "Richard Campbell",
      "youtubeUrl": "https://www.youtube.com/watch?v=...",
      "videoTitle": "...",
      "channel": "NDC Conferences",
      "matchType": "same-title-prior-year",
      "matchConfidence": "high",
      "notes": "..."
    }
  ]
}
```

Confidence breakdown: 42 high, 25 medium, 5 low.
Match-type breakdown: 38 same-title-prior-year, 31 same-speaker-similar-topic, 3 same-speaker-other-talk.

## `complete_youtubes.py` — CLI tool to fill in the gaps

Added `/home/mpayne/Work/kcdc/complete_youtubes.py`, a standalone Python 3 script
(no pip deps; shells out to the `yt-dlp` CLI for search, no API key needed) that
searches YouTube for prior talks by speakers still missing a match and appends
new entries to `youtubes.json`, recomputing all the summary counts/lists.

Usage: `python3 complete_youtubes.py [--speaker NAME ...] [--limit N] [--dry-run]
[--all] [--redo-low-confidence] [--allow-unverified-speaker] [--min-confidence ...]`
— run with no args to sweep every session that doesn't have a match yet. Full
`--help` has all flags.

**Matching logic (important, learned the hard way):** it queries
`ytsearch5:"<speaker> <session title>"` via `yt-dlp --flat-playlist`, then scores
each candidate by (a) whether the speaker's name literally appears in the video
title and (b) `difflib` title-similarity between the session title and video
title. **By default it REQUIRES the speaker's name to appear in the video title**
before accepting a match at all — a first version scored on title-similarity
alone and it silently attributed a *different* speaker's video to the wrong
person (an "Erik Shafer" session matched to a Jason Taylor GOTO talk, both
titled around "Clean Architecture"). That run was reverted. The unsafe
title-only path still exists but is opt-in via `--allow-unverified-speaker`,
always capped at `matchConfidence: "low"`, and its `notes` field says explicitly
that the speaker's name wasn't found and it needs verification — don't relax
that default without spot-checking a sample of results afterward the way this
session did (`git`-less repo, so there's no diff to review — compare against
what `speakersSearchedWithNoMatchFound` looked like before the run, or just eyeball
a random sample of new entries).

Every auto-written match's `notes` field says "Auto-matched by
complete_youtubes.py" so they're distinguishable from the original hand/agent-
verified batch — worth keeping in mind if quality ever needs auditing.

## Coverage gap / what's left undone

- As of the last `complete_youtubes.py` run (2026-09-04): **65 of 147 speakers
  have at least one match** (90 matches total, 78 sessions covered) — up from the
  original 53/147 (72 matches). **82 speakers still have zero matches** — the
  script only accepts a match when the speaker's name appears in a candidate
  video's title, so plenty of real prior talks are being missed simply because
  the video title doesn't happen to include the speaker's name (e.g. conference
  channels that title videos "<Talk Title> — <Conference> <Year>" with speaker
  name only in the description, not the title). Re-running with
  `--allow-unverified-speaker` would raise coverage further but at real
  false-positive risk (see above) — only use it if someone will review the
  results, and treat everything it adds as "low confidence, unverified" by design.
- The full list of unmatched speakers is in `youtubes.json` under
  `speakersSearchedWithNoMatchFound`.
- If asked to improve coverage further: re-run `complete_youtubes.py` (it's
  idempotent/resumable — it skips sessions that already have a match unless
  `--all`/`--redo-low-confidence` is passed), or wait until after Sept 11, 2026
  and re-pull `https://kcdc2026.sessionize.com/api/schedule` — once KCDC
  publishes real 2026 recordings, `recordingUrl` will populate directly on
  session objects and `youtubes.json` could be rebuilt from ground truth instead
  of inference.

## Reusable scratchpad files (temp, not deliverables)

All under the session's scratchpad dir (`/tmp/claude-1000/-home-mpayne-Work-kcdc/.../scratchpad/`):
- `schedule_raw.json` — raw Sessionize API dump (sessions/speakers/rooms/etc.)
- `speaker_batch_0.json` .. `speaker_batch_9.json` — input batches for the fork agents
- `youtube_matches_0.json` .. `youtube_matches_9.json` — per-batch search results
- `all_matches_merged.json` — the merged 72-match array before final envelope was added

## `build_db.py` — builds `kcdc.db` (SQLite) from the two JSON files

Added `/home/mpayne/Work/kcdc/build_db.py`, a standalone Python 3 script (stdlib
only — `json` + `sqlite3`) that reads `kcdc-2026-sessions.json` and
`youtubes.json` and writes a normalized SQLite database.

Usage: `python3 build_db.py [--sessions PATH] [--youtubes PATH] [--output kcdc.db]
[--force]` — refuses to overwrite an existing `--output` unless `--force` is passed.

**Schema** (normalized, speakers deduped by exact-name match across both source
files — both files use plain full-name strings, no GUIDs, so joining on `name`
is safe and was verified to produce exactly 147 distinct speakers, matching
`youtubes.json`'s own `totalSpeakers` count):
- `meta(source_file, key, value)` — every top-level scalar/list field from both
  JSON files that isn't itself the row data (e.g. `event`, `generatedAt`,
  `note`, `matchTypeLegend`, counts), tagged by which file it came from, so the
  original envelope metadata isn't lost.
- `speakers(id, name)` — deduped speaker list, 147 rows.
- `sessions(id, title, description, starts_at, ends_at, room, status,
  is_service_session, is_plenum_session, live_url, recording_url)` — 207 rows,
  1:1 with `kcdc-2026-sessions.json`'s `sessions[]`, booleans stored as 0/1.
- `session_speakers(session_id, speaker_id)` — join table unpacking each
  session's `speakers[]` array (213 rows: 207 sessions but some have 2+
  speakers).
- `youtube_matches(id, session_id, speaker_id, youtube_url, video_title,
  channel, match_type, match_confidence, notes)` — 90 rows, 1:1 with
  `youtubes.json`'s `matches[]`.
- `unmatched_speakers(speaker_id)` — 82 rows, from
  `youtubes.json.speakersSearchedWithNoMatchFound`.

Ran once with `--force` and spot-checked with `sqlite3 kcdc.db` joins (row
counts match the source JSON exactly: 207/147/213/90/82). **This has not yet
been committed to git** — the repo currently has no commits at all (`git log`
is empty on `master`), so `kcdc.db`, `build_db.py`, and everything else in the
working tree is still untracked.

**If source JSON changes later:** re-run `python3 build_db.py --force` to
rebuild `kcdc.db` from scratch — it's a full rebuild, not an incremental
update, so it's always safe to just delete-and-regenerate rather than trying
to diff/patch the db in place.
