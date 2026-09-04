#!/usr/bin/env python3
"""
Search YouTube for prior talks by KCDC 2026 speakers and fill in the gaps
in youtubes.json.

KCDC 2026 hasn't happened yet, so there are no recordings of the actual
2026 sessions. This tool finds prior talks by the same speaker on the same
or a related topic (same approach used to seed youtubes.json originally),
using `yt-dlp` search (no API key required) and writes new matches back
into the file.

Usage:
    python3 complete_youtubes.py                       # search all unmatched sessions
    python3 complete_youtubes.py --speaker "Cory House" # search one speaker only
    python3 complete_youtubes.py --limit 10             # only process 10 sessions this run
    python3 complete_youtubes.py --dry-run              # search + score, don't write
    python3 complete_youtubes.py --redo-low-confidence  # also re-search sessions whose
                                                          # only existing match is "low"

Requires the `yt-dlp` CLI on PATH.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_SESSIONS = Path("kcdc-2026-sessions.json")
DEFAULT_YOUTUBES = Path("youtubes.json")


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).strip()


def name_parts(speaker: str) -> list[str]:
    # Drop parenthetical/quoted nicknames, e.g. Matt "Kelly" Williams -> Matt Williams
    cleaned = re.sub(r'"[^"]*"', " ", speaker)
    return [p for p in re.split(r"\s+", cleaned) if len(p) > 1]


def speaker_present(speaker: str, video_title: str) -> bool:
    parts = name_parts(speaker)
    if not parts:
        return False
    title_l = video_title.lower()
    hits = sum(1 for p in parts if re.search(rf"\b{re.escape(p.lower())}\b", title_l))
    # require all parts for short names, allow one miss for 3+ part names
    return hits >= len(parts) if len(parts) <= 2 else hits >= len(parts) - 1


def title_similarity(session_title: str, video_title: str) -> float:
    # video titles are often "<talk title> - <speaker> - <conference> <year>";
    # compare against the whole string and just the segment before the first
    # " - ", and keep the better of the two.
    a = normalize(session_title)
    b_full = normalize(video_title)
    b_head = normalize(video_title.split(" - ")[0])
    return max(
        difflib.SequenceMatcher(None, a, b_full).ratio(),
        difflib.SequenceMatcher(None, a, b_head).ratio(),
    )


def classify(
    session_title: str, video_title: str, speaker: str, require_speaker_in_title: bool
) -> tuple[str, str] | None:
    """Return (matchType, matchConfidence), or None if too weak to trust.

    The speaker's name appearing in the video title is the load-bearing signal:
    title-similarity alone will happily "match" a *different* speaker's talk that
    shares a common topic/title (e.g. two different people both giving a "Clean
    Architecture" talk at different conferences). By default we require the name
    to be present so we never silently attribute someone else's video to this
    speaker; --allow-unverified-speaker opts into the riskier topic-only path
    (always capped at "low" confidence) for manual review.
    """
    sim = title_similarity(session_title, video_title)
    present = speaker_present(speaker, video_title)

    if present:
        if sim >= 0.6:
            return "same-title-prior-year", ("high" if sim >= 0.75 else "medium")
        if sim >= 0.3:
            return "same-speaker-similar-topic", ("high" if sim >= 0.45 else "medium")
        return "same-speaker-other-talk", "low"

    if require_speaker_in_title:
        return None

    # Name not found in the title -- only ever "low" confidence, and only
    # offered when the caller explicitly opted in.
    if sim >= 0.55:
        return "same-title-prior-year", "low"
    if sim >= 0.4:
        return "same-speaker-similar-topic", "low"
    return None


def yt_search(query: str, max_results: int, retries: int = 2) -> list[dict]:
    cmd = [
        "yt-dlp",
        f"ytsearch{max_results}:{query}",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--socket-timeout", "20",
    ]
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            if attempt < retries:
                time.sleep(2)
                continue
            print(f"  ! search timed out: {query!r}", file=sys.stderr)
            return []
        if proc.returncode != 0 and not proc.stdout:
            if attempt < retries:
                time.sleep(2)
                continue
            print(f"  ! yt-dlp failed for {query!r}: {proc.stderr.strip()[:200]}", file=sys.stderr)
            return []
        results = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                results.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return results
    return []


def load_json(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp.replace(path)


def build_session_index(sessions_data: dict, speaker_filter: set[str] | None) -> list[dict]:
    out = []
    for s in sessions_data["sessions"]:
        if s.get("isServiceSession") or s.get("isPlenumSession"):
            continue
        for speaker in s.get("speakers", []):
            if speaker_filter and speaker not in speaker_filter:
                continue
            out.append({"sessionId": s["id"], "sessionTitle": s["title"], "speaker": speaker})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sessions", type=Path, default=DEFAULT_SESSIONS, help="path to kcdc-2026-sessions.json")
    ap.add_argument("--youtubes", type=Path, default=DEFAULT_YOUTUBES, help="path to youtubes.json (read + written)")
    ap.add_argument("--output", type=Path, default=None, help="write to a different file instead of --youtubes")
    ap.add_argument("--speaker", action="append", help="only search this speaker (repeatable)")
    ap.add_argument("--limit", type=int, default=None, help="stop after processing this many sessions")
    ap.add_argument("--max-results", type=int, default=5, help="YouTube search results to consider per session (default 5)")
    ap.add_argument("--min-confidence", choices=["low", "medium", "high"], default="low",
                     help="auto-accept threshold; candidates scoring below this are skipped (default low -- "
                          "a similarity floor is already applied before classification)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds to sleep between searches (default 1.0)")
    ap.add_argument("--redo-low-confidence", action="store_true",
                     help="also re-search sessions whose only existing match(es) are all 'low' confidence")
    ap.add_argument("--all", action="store_true", help="search every session, even ones that already have a match")
    ap.add_argument("--dry-run", action="store_true", help="search and print candidates, but don't write the file")
    ap.add_argument("--allow-unverified-speaker", action="store_true",
                     help="also accept candidates whose video title never mentions the speaker's name, based on "
                          "title-topic similarity alone (always 'low' confidence; higher false-positive risk -- "
                          "a similarly-titled talk by a DIFFERENT speaker can pass this. Off by default.)")
    args = ap.parse_args()

    conf_rank = {"low": 0, "medium": 1, "high": 2}
    min_rank = conf_rank[args.min_confidence]

    sessions_data = load_json(args.sessions)
    youtubes = load_json(args.youtubes)

    speaker_filter = set(args.speaker) if args.speaker else None
    all_pairs = build_session_index(sessions_data, speaker_filter)

    existing_by_session: dict[str, list[dict]] = {}
    for m in youtubes["matches"]:
        existing_by_session.setdefault(m["sessionId"], []).append(m)

    def needs_search(session_id: str) -> bool:
        if args.all:
            return True
        matches = existing_by_session.get(session_id)
        if not matches:
            return True
        if args.redo_low_confidence and all(m.get("matchConfidence") == "low" for m in matches):
            return True
        return False

    todo = [p for p in all_pairs if needs_search(p["sessionId"])]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(todo)} session/speaker pairs to search "
          f"(of {len(all_pairs)} total real sessions x speakers)", file=sys.stderr)

    existing_urls = {m["youtubeUrl"] for m in youtubes["matches"]}
    new_matches: list[dict] = []

    for i, pair in enumerate(todo, 1):
        speaker, title, sid = pair["speaker"], pair["sessionTitle"], pair["sessionId"]
        query = f"{speaker} {title}"
        print(f"[{i}/{len(todo)}] {speaker!r} / {title!r}", file=sys.stderr)
        results = yt_search(query, args.max_results)

        best = None
        best_rank = -1
        for r in results:
            vtitle = r.get("title") or ""
            url = r.get("url") or (f"https://www.youtube.com/watch?v={r['id']}" if r.get("id") else None)
            if not url or url in existing_urls:
                continue
            classified = classify(title, vtitle, speaker, not args.allow_unverified_speaker)
            if classified is None:
                continue
            match_type, confidence = classified
            rank = conf_rank[confidence]
            if rank > best_rank:
                best_rank = rank
                name_seen = speaker_present(speaker, vtitle)
                note = (
                    "Auto-matched by complete_youtubes.py via yt-dlp search; speaker's name appears in the "
                    "video title. Unverified beyond that -- spot-check before treating as ground truth."
                    if name_seen else
                    "Auto-matched by complete_youtubes.py via yt-dlp search on TITLE SIMILARITY ONLY -- the "
                    "speaker's name does NOT appear in the video title/channel. Meaningful risk this is a "
                    "different speaker's talk on the same topic. Verify before trusting."
                )
                best = {
                    "sessionId": sid,
                    "sessionTitle": title,
                    "speaker": speaker,
                    "youtubeUrl": url,
                    "videoTitle": vtitle,
                    "channel": r.get("channel") or r.get("uploader") or "",
                    "matchType": match_type,
                    "matchConfidence": confidence,
                    "notes": note,
                }

        if best and best_rank >= min_rank:
            print(f"    -> {best['matchConfidence']:6s} {best['matchType']:28s} {best['youtubeUrl']}", file=sys.stderr)
            new_matches.append(best)
            existing_urls.add(best["youtubeUrl"])
        else:
            print("    -> no acceptable match", file=sys.stderr)

        if i < len(todo):
            time.sleep(args.delay)

    if args.dry_run:
        print(f"\nDRY RUN: would add {len(new_matches)} matches. Not writing.", file=sys.stderr)
        print(json.dumps(new_matches, indent=2))
        return 0

    youtubes["matches"].extend(new_matches)

    matched_speakers = {m["speaker"] for m in youtubes["matches"]}
    matched_sessions = {m["sessionId"] for m in youtubes["matches"]}
    all_speaker_names = {p["speaker"] for p in all_pairs}
    youtubes["speakersSearchedWithNoMatchFound"] = sorted(all_speaker_names - matched_speakers)
    youtubes["speakersWithAtLeastOneMatch"] = len(matched_speakers)
    youtubes["sessionsWithAtLeastOneMatch"] = len(matched_sessions)
    youtubes["matchCount"] = len(youtubes["matches"])
    youtubes["generatedAt"] = time.strftime("%Y-%m-%d")

    out_path = args.output or args.youtubes
    save_json(out_path, youtubes)
    print(f"\nAdded {len(new_matches)} matches. Wrote {out_path} "
          f"({youtubes['matchCount']} total matches, "
          f"{youtubes['speakersWithAtLeastOneMatch']}/{youtubes['totalSpeakers']} speakers covered).",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
