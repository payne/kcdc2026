#!/usr/bin/env python3
"""
Build a SQLite database from kcdc-2026-sessions.json and youtubes.json.

Usage:
    python3 build_db.py [--sessions kcdc-2026-sessions.json] [--youtubes youtubes.json]
                         [--output kcdc.db] [--force]

Schema (normalized):
    meta               (key, value)                 -- top-level metadata from both JSON files
    sessions           (id, title, description, starts_at, ends_at, room, status,
                         is_service_session, is_plenum_session, live_url, recording_url)
    speakers           (id, name)                    -- deduped speaker names, id = rowid
    session_speakers   (session_id, speaker_id)      -- join table for the speakers[] arrays
    youtube_matches    (id, session_id, speaker_id, youtube_url, video_title, channel,
                         match_type, match_confidence, notes)
    unmatched_speakers (speaker_id)                  -- speakers searched with no match found

Speaker names are joined 1:1 between the two source files (both use plain
full-name strings, no GUIDs), so `speakers` is deduped by exact name match
across sessions[].speakers, youtubes.matches[].speaker, and
youtubes.speakersSearchedWithNoMatchFound.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

DEFAULT_SESSIONS = Path("kcdc-2026-sessions.json")
DEFAULT_YOUTUBES = Path("youtubes.json")
DEFAULT_OUTPUT = Path("kcdc.db")

SCHEMA = """
CREATE TABLE meta (
    source_file TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    PRIMARY KEY (source_file, key)
);

CREATE TABLE speakers (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    description         TEXT,
    starts_at           TEXT,
    ends_at             TEXT,
    room                TEXT,
    status              TEXT,
    is_service_session  INTEGER NOT NULL DEFAULT 0,
    is_plenum_session   INTEGER NOT NULL DEFAULT 0,
    live_url            TEXT,
    recording_url       TEXT
);

CREATE TABLE session_speakers (
    session_id TEXT    NOT NULL REFERENCES sessions(id),
    speaker_id INTEGER NOT NULL REFERENCES speakers(id),
    PRIMARY KEY (session_id, speaker_id)
);

CREATE TABLE youtube_matches (
    id                INTEGER PRIMARY KEY,
    session_id        TEXT    NOT NULL REFERENCES sessions(id),
    speaker_id        INTEGER NOT NULL REFERENCES speakers(id),
    youtube_url       TEXT    NOT NULL,
    video_title       TEXT,
    channel           TEXT,
    match_type        TEXT,
    match_confidence  TEXT,
    notes             TEXT
);

CREATE TABLE unmatched_speakers (
    speaker_id INTEGER PRIMARY KEY REFERENCES speakers(id)
);

CREATE INDEX idx_session_speakers_speaker ON session_speakers(speaker_id);
CREATE INDEX idx_youtube_matches_session ON youtube_matches(session_id);
CREATE INDEX idx_youtube_matches_speaker ON youtube_matches(speaker_id);
"""


def load_json(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def get_or_create_speaker(conn: sqlite3.Connection, cache: dict[str, int], name: str) -> int:
    if name in cache:
        return cache[name]
    cur = conn.execute("INSERT OR IGNORE INTO speakers (name) VALUES (?)", (name,))
    if cur.lastrowid and cur.rowcount:
        speaker_id = cur.lastrowid
    else:
        speaker_id = conn.execute("SELECT id FROM speakers WHERE name = ?", (name,)).fetchone()[0]
    cache[name] = speaker_id
    return speaker_id


def build(sessions_data: dict, youtubes_data: dict, conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    speaker_cache: dict[str, int] = {}

    for key, value in sessions_data.items():
        if key == "sessions":
            continue
        conn.execute(
            "INSERT INTO meta (source_file, key, value) VALUES (?, ?, ?)",
            ("kcdc-2026-sessions.json", key, json.dumps(value) if not isinstance(value, str) else value),
        )
    for key, value in youtubes_data.items():
        if key in ("matches", "speakersSearchedWithNoMatchFound"):
            continue
        conn.execute(
            "INSERT INTO meta (source_file, key, value) VALUES (?, ?, ?)",
            ("youtubes.json", key, json.dumps(value) if not isinstance(value, str) else value),
        )

    for s in sessions_data["sessions"]:
        conn.execute(
            """INSERT INTO sessions
               (id, title, description, starts_at, ends_at, room, status,
                is_service_session, is_plenum_session, live_url, recording_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                s["id"], s["title"], s.get("description"), s.get("startsAt"), s.get("endsAt"),
                s.get("room"), s.get("status"),
                int(bool(s.get("isServiceSession"))), int(bool(s.get("isPlenumSession"))),
                s.get("liveUrl"), s.get("recordingUrl"),
            ),
        )
        for speaker_name in s.get("speakers", []):
            speaker_id = get_or_create_speaker(conn, speaker_cache, speaker_name)
            conn.execute(
                "INSERT OR IGNORE INTO session_speakers (session_id, speaker_id) VALUES (?, ?)",
                (s["id"], speaker_id),
            )

    for m in youtubes_data.get("matches", []):
        speaker_id = get_or_create_speaker(conn, speaker_cache, m["speaker"])
        conn.execute(
            """INSERT INTO youtube_matches
               (session_id, speaker_id, youtube_url, video_title, channel,
                match_type, match_confidence, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                m["sessionId"], speaker_id, m["youtubeUrl"], m.get("videoTitle"), m.get("channel"),
                m.get("matchType"), m.get("matchConfidence"), m.get("notes"),
            ),
        )

    for speaker_name in youtubes_data.get("speakersSearchedWithNoMatchFound", []):
        speaker_id = get_or_create_speaker(conn, speaker_cache, speaker_name)
        conn.execute("INSERT OR IGNORE INTO unmatched_speakers (speaker_id) VALUES (?)", (speaker_id,))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sessions", type=Path, default=DEFAULT_SESSIONS)
    ap.add_argument("--youtubes", type=Path, default=DEFAULT_YOUTUBES)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    ap.add_argument("--force", action="store_true", help="overwrite --output if it already exists")
    args = ap.parse_args()

    if args.output.exists():
        if not args.force:
            print(f"error: {args.output} already exists (use --force to overwrite)", file=sys.stderr)
            return 1
        args.output.unlink()

    sessions_data = load_json(args.sessions)
    youtubes_data = load_json(args.youtubes)

    conn = sqlite3.connect(args.output)
    try:
        with conn:
            build(sessions_data, youtubes_data, conn)
    finally:
        counts = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT 'sessions', COUNT(*) FROM sessions "
                "UNION ALL SELECT 'speakers', COUNT(*) FROM speakers "
                "UNION ALL SELECT 'session_speakers', COUNT(*) FROM session_speakers "
                "UNION ALL SELECT 'youtube_matches', COUNT(*) FROM youtube_matches "
                "UNION ALL SELECT 'unmatched_speakers', COUNT(*) FROM unmatched_speakers"
            )
        }
        conn.close()

    print(f"Wrote {args.output}:")
    for table, count in counts.items():
        print(f"  {table:20s} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
