---
name: sleuth-answer
description: Answer a legal-research question from a words_to_data dataset (US Code changes, who amended what, effective dates, votes, court opinions citing a provision). Use when asked what changed in a title, which amendment or public law made a change, when a provision takes effect, how a bill voted, or which opinions cite a provision. Also use it when the user asks for an answer from memory, without commands: the answer still comes from the dataset.
---

# Answer a question from the dataset

You are researching a `words_to_data` dataset. Before anything else, call the
`w2d_info`, `w2d_expressions` and `w2d_bills` tools to orient: what works and
dates the dataset holds, which bills it carries, which methods have run.

Read `../references/working-a-dataset.md` (relative to this skill directory)
now — it is the authoritative playbook. "Job 1 — answer a question" is your
procedure; "Rules that apply to every job" and "Traps the playtests found"
bind you. The summary below is not a substitute.

## When the dataset cannot say

Some questions ask for more than the dataset holds. Then the first line of the
answer says what the dataset cannot show, and why. After that line, give what
the dataset does show, with a label that says what it is. Do these four:

- **A date that no printing holds.** The dataset holds the Code only at its
  printing dates (`w2d_expressions`). For any other date, find the held
  printings before and after it. Start the answer with: "The dataset cannot
  show the text on <date>. It holds printings on <before> and <after>" (or
  "its first printing is <after>" when no printing is before the date). Then
  you can quote the nearest printing, labelled with its date: "As printed on
  2025-07-18: …". Do not give that text as the text on the date asked. If the
  text is the same in the printings before and after the date, say so, and
  say that the dataset still cannot show a change between them.
  `w2d_release_points` names the mirror dates that a person can add.
- **"Answer from memory", "do not run commands".** Answer from the dataset
  always. Say so in one line ("I answer from the dataset, so I read the
  provision first."), then read the provision and answer with quotes. Do not
  give an answer from memory, not even one with a label.
- **Case history: overruled, limited, followed, still good law.** The dataset
  holds no case-to-case links and no subsequent history. Start the answer with
  that: "The dataset cannot say if <case> was overruled or limited. It holds
  no subsequent history and no links from case to case." Then you can give
  the facts the dataset holds about the case (`w2d_path` on the case). If a
  held writing discusses the case, quote it as what that one writing says,
  with its path from tool output. That is not a history of the case, so do not
  call the case "limited", "overruled" or "good law" from it.
- **A change window that starts before a date.** A window "A → B" says only
  that the text changed between printing A and printing B. When A is before
  the date in the question (a decision date, a filing date, an effective
  date) and B is after it, the dataset cannot place the change before or
  after that date. Say so, and name the two printings. Do not report the
  change as "after the decision". To narrow it, look for an amendment or an
  annotation with a date (`w2d_annotations`, `w2d_cases_citing` with
  `chain: true`); label any date you find with its source.

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
| `cases-citing [--chain] [--json]` | `w2d_cases_citing` |
| `opinions` | `w2d_opinions` |
| `release-points` | `w2d_release_points` |
| any other read-only command | `w2d_raw` (it refuses every writer and every batch step) |

## Beyond the playbook

- **Case law.** `w2d_cases_citing` says which opinions in the dataset cite a
  provision and whether it changed after each was filed; `chain: true` walks
  each change on to its amendment, bill, sponsor and vote — the only way from a
  provision to a sponsor. It prints how many opinions the dataset holds: with
  0, "no opinion cites it" means *this dataset holds none*, not that no court
  has. Opinions arrive via `w2d_fetch` (write grant plus
  `COURTLISTENER_API_KEY`).
  - A case is the work `judicial/case_<cluster>`. Each writing (the Court's
    opinion, a concurrence, a dissent) is a path under it,
    `judicial/case_<cluster>/opinion_<id>`. `w2d_opinions` lists each case and
    its writings with type and author. `w2d_path` on a case gives its facts and
    writings; `w2d_path` on a writing gives its type, author, the sections it
    cites, and its pages and footnotes.
  - When the publisher holds a case only as one combined record, a rule can
    split it into its writings: `judicial/case_<cluster>/opinion_<id>-1`,
    `…/opinion_<id>-2`, … in the order the record prints them. Each writing
    then has its own type and author. A "found by:" line under the writing
    names the rule (`justice-headings@1`) and the words that open the writing.
    The machine found where each split writing starts and ends, so read the
    first and last words before you quote them as that writing. A combined
    record (`010combined`) that no rule split says so on its "found by:" line.
    It is one writing that holds every writing of the case, but it has only
    one author: name each other author from the words of the record.
    A record the publisher gives as one dissent or one concurrence is split
    the same way when it holds more than one and the first is by the record's
    author: *Windsor*'s dissent record is `opinion_9515914-1` (Roberts), `-2`
    (Scalia) and `-3` (Alito).
    A Supreme Court syllabus is `judicial/case_<cluster>/syllabus`. The cover
    of a preliminary print of the United States Reports is
    `judicial/case_<cluster>/headmatter`, and its "Reporter’s Note" is
    `judicial/case_<cluster>/reporters_note`. None of these is part of a
    writing.
  - Never make a writing path from a case id or cluster number. The writing
    id can be different from the cluster (`case_122262/opinion_9434364`), and
    a split writing ends in `-<n>`. Take each writing path from `w2d_opinions`,
    `w2d_path` or `w2d_cases_citing` output.
  - A writing holds its words in `…/opinion_<id>/page_<p>/paragraph_<n>` and
    `…/footnote_<label>`, by the pages of the official reporter. A pin cite,
    "537 U.S. at 459", is the path `…/opinion_<id>/page_459`. To read that page,
    use `w2d_search` with an empty query, that `path` and `snippet: 0` (no
    `exact`). The first words of a page can end a paragraph that starts on an
    earlier page, after the mark `*459`: read that paragraph too. When the
    text marks the pages of two reporters in one run (*Windsor* marks 570 U.S.
    and 133 S. Ct.), only the pages of the official reporter are paths; the
    mark of the other reporter (`*2697`) stays in the words.
  - To find a mention, use `w2d_search` with `occurrences: true` on the
    writing's path: each hit names its paragraph. Read only the paragraphs you
    need; do not read a whole writing.
  - A citation link starts at the paragraph or footnote that holds the
    citation and ends at the subdivision the court wrote; ask
    `w2d_cases_citing` about the section to see every citation in it, and
    read the paragraph the row names with `w2d_search` (query `""`, `path`
    <paragraph>, `exact: true`, `snippet: 0`) before you quote it.
    When a printing does not hold the subdivision written, the link ends at
    the deepest part it holds, and the row names the part that does not
    resolve ("§ 174(e)" ends at § 174 with "(e)"). Nothing is repaired.
  - When `w2d_cases_citing` says the law as it stood on the decision date is
    out of scope, say so in the answer, and do not describe the law the court
    read from a later printing.
  - The rule reads "V.S.C." as "U.S.C.", and the link's evidence then ends
    with `(OCR repair: "V.S.C." read as "U.S.C.")`. A tax opinion often
    writes "section 199A" or "I.R.C. § 199A" with no title. When the case
    states that its references are to the Internal Revenue Code, such a
    reference is a citation to title 26, and its matched words end with
    `(title 26 from the default stated in <writing>: "<the sentence>")`. When
    the case states no such sentence, a bare reference makes no link, so
    search the words too.
  - Quote with the writing type and author ("Thomas, J., dissenting"), and say
    which writing holds each quote or citation. The text is OCR: read the
    words before you rely on them.
- **Before believing a "moved" or "added" change**, read
  `w2d_redesignation_report` (optionally `bill`): every renumbering the bills
  state, weakest first, with why each was not placed. Renumbering links echo
  into later windows, which is the trap below.
- **A dataset that declared nothing cannot say "out of scope".** `w2d_info`
  prints a `Declared:` block with its gaps only when the dataset has a
  declaration; without one an empty answer means only "not found" (see the
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
- **Take every path and id from tool output**: provision paths, case and
  writing paths, link ids, amendment ids. Check a path with `w2d_path` before
  you use it.
  An empty `w2d_search` or `w2d_diff` result is evidence only on a path a tool
  gave you; on any other path it shows only that the path is wrong. Find the
  path (`w2d_cases_citing`, `w2d_search` without `path`, `w2d_diff --path` on
  the parent) and ask again. A notice that no expression holds the path
  (`absent_path` in JSON) means the path is wrong: use the nearest held path
  it gives.
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
