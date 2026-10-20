---
name: sleuth-answer
description: Answer a legal-research question from a words_to_data dataset (US Code changes, who amended what, effective dates, votes, court opinions citing a provision). Use when asked what changed in a title, which amendment or public law made a change, when a provision takes effect, how a bill voted, or which opinions cite a provision.
---

# Answer a question from the dataset

You are researching a `words_to_data` dataset. Before anything else, call the
`w2d_info`, `w2d_expressions` and `w2d_bills` tools to orient: what works and
dates the dataset holds, which bills it carries, which methods have run.

Read `../references/working-a-dataset.md` (relative to this skill directory)
now — it is the authoritative playbook. "Job 1 — answer a question" is your
procedure; "Rules that apply to every job" and "Traps the playtests found"
bind you. The summary below is not a substitute.

## Tool mapping

The playbook's commands are tools. If no dataset is registered, register the
one the user named with `w2d_dataset` (reads stay read-only; writes need a
human to run `/dataset <path> --write`):

| Playbook command | Tool |
| --- | --- |
| `info`, `expressions`, `bills`, `validate` | `w2d_info`, `w2d_expressions`, `w2d_bills`, `w2d_validate` |
| `search <ds> "q" --work W --at D` | `w2d_search` |
| `diff --from X@d1 --to X@d2 --path P` | `w2d_diff` |
| `path <ds> P --from --to` | `w2d_path` |
| `annotations --bill --path` | `w2d_annotations` |
| `settle --link <id> --explain` | `w2d_settle` (explain) |
| `votes <ds> <bill>` | `w2d_votes` |
| `residue`, `coverage`, `show-bill` | `w2d_residue`, `w2d_coverage`, `w2d_show_bill` |
| `amendment-addresses`, `redesignation-report` | `w2d_amendment_addresses`, `w2d_redesignation_report` |
| `section-agreement`, `contradictions` | `w2d_section_agreement`, `w2d_contradictions` |
| `cases-citing [--chain]` | `w2d_cases_citing` |
| any other read-only command | `w2d_raw` (it refuses every writer and every batch step) |

## Beyond the playbook

- **Case law.** `w2d_cases_citing` says which opinions in the dataset cite a
  provision and whether it changed after each was filed; `chain: true` walks
  each change on to its amendment, bill, sponsor and vote — the only way from a
  provision to a sponsor. It prints how many opinions the dataset holds: with
  0, "no opinion cites it" means *this dataset holds none*, not that no court
  has. Opinions arrive as `judicial/opinion_<id>` works via `w2d_fetch` (write
  grant plus `COURTLISTENER_API_KEY`), and their text is searchable with
  `w2d_search --work judicial/opinion_<id>`.
- **Before believing a "moved" or "added" change**, read
  `w2d_redesignation_report` (optionally `bill`): every renumbering the bills
  state, weakest first, with why each was not placed. Renumbering links echo
  into later windows, which is the trap below.
- **A dataset that declared nothing cannot say "out of scope".** `w2d_info`
  prints a `Declared:` block with its gaps only when the dataset was built with
  a declaration; without one an empty answer means only "not found" (see the
  sleuth-build skill).

## What no command answers

These are gaps in the command, not in you. Answer them with `w2d_sql` and
record each with `w2d_gap_record`, so the missing command becomes an issue:

- **Who sponsored or cosponsored a bill, and when** — the `sponsors` table has
  it; `w2d_bills` prints only the bill id and amendment counts.
- **How one member voted**, or a roll call across a whole congress —
  `member_votes` and `roll_calls` hold it; `w2d_votes` counts by the party each
  member held on the vote's date and names only the members whose party the
  date cannot settle.
- **A member's party, state, district or terms** — the `members` table.

Do **not** reach for SQL to search text: `w2d_search` searches every text
field (heading, chapeau, content, proviso, continuation) and names the field it
matched, so a proviso hit is a real hit.

## Hard rules (from the playbook, enforced)

- **Commands first, SQL last.** Prefer the `w2d_*` tools, then `w2d_raw` for a
  read-only command with no tool of its own. `w2d_sql` is read-only and only
  for questions no command answers at all; every `w2d_sql` peek MUST be
  followed by `w2d_gap_record` (question, SQL, the command that should have
  existed). The session's gap list goes in your final report. A refusal from
  `w2d_raw` naming an unknown subcommand is such a gap — report it, do not work
  around it.
- **Every claim needs evidence you have seen** — quote the words at both ends
  of a change from tool output. Never from memory about the law.
- **Label outside knowledge** (e.g. which party a member belongs to, the
  default effective-date rule) as outside the dataset.
- **Before reporting a change in a later window**, compare the whole text at
  both dates (`w2d_search` with empty query, `--path`, `--snippet 0`, at each
  date): renumbering echoes fake "moves" into later windows.
- Distinguish **the Code shows it** (printed at a date) from **it is in
  force** (effective-date words in or around the text). Beware run-in margin
  notes like "(F) Effective date.beginning on…".

## Report

End with the playbook's report: the answer with its evidence quotes, what came
from outside the dataset, anything the commands could not tell you (run
`/sleuth-gaps` to include the SQL gap list).
