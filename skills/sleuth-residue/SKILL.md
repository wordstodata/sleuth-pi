---
name: sleuth-residue
description: Resolve the residue of a public law in a words_to_data dataset — the amendments the evidence-matching batch could not link (category "work"), deciding address/window/resolve stages and recording link or no-link verdicts. Use when asked to work a bill's residue or resolve unlinked amendments.
---

# Resolve the residue

You are clearing the unlinked amendments of one public law in a `words_to_data`
dataset. This is Job 2 of the playbook: read
`../references/working-a-dataset.md` (relative to this skill directory) fully
before acting. Its stage recipes — address, window, resolve — are the
procedure; its "Things that look wrong but are the data" section prevents
false alarms.

## Procedure

1. `w2d_amendment_addresses` with `bill` first. It prints every amendment of
   the law with its Code address, **or the reason none is known** ("section 112
   is a section of another law, and nothing places it in the Code", "no level
   above the clause says what it amends") — the map for the address stage, for
   linked and unlinked amendments alike. `--amendment` narrows to one.
2. `w2d_residue` with `json: true` on the bill. Work only `work` rows;
   `not_held`, `quiet`, and `reviewed: no link` need nothing unless you
   disagree, in which case say why in the report.
3. **Before any stage recipe, read the effective date.** `w2d_search` the
   public law's own text (`--work publiclawdocument_<id>`) for "shall apply"
   near the amendment's `law_section`. A change effective after the newest
   release point is not a failure: record `no_link: not_yet_in_corpus` with the
   quoted words. In the first playtest, 8 of 22 unlinked items were this.
4. Work the stage recipe for the row. Use `w2d_diff --path` (and `--exact` for
   one provision), `w2d_path`, `w2d_search`, `w2d_annotations` with `path` to
   find candidate changes; `w2d_redesignation_report` before believing a
   candidate is a move. Link only a change whose words match what the amendment
   says. In a genuine tie, read both amendments and each candidate; if you still
   cannot tell, record nothing and say why.
5. Record with `w2d_link_amendment` — full hex amendment id from
   `w2d_residue --json` or `w2d_show_bill --json`, never the 12-char display
   prefix. `--source agent:sleuth`, `--method resolve-residue@1`, and a
   `reason` quoting the amendment's words and the words that changed: a person
   will check you. A no-link conclusion uses `noLink` with a reason.
6. Re-run `w2d_residue` at the end — it shows the items you skipped.

## Hard rules

- **Writes require the session grant.** If the tools refuse, the user must run
  `/dataset <path> --write` first. Never write to an ungranted dataset.
- **A wrong link is worse than no link.** When evidence is unclear, record
  nothing and report why.
- Commands first; `w2d_sql` only for gaps, and every peek gets a
  `w2d_gap_record`.
- Your record is `MachineSuggested`; a human or another agent may refute it.

## Report

Per the playbook: each record you wrote (link, no-link) with its id; each item
left alone and why; anything the commands could not tell you (include
`/sleuth-gaps` output).
