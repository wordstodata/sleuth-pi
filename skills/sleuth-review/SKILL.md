---
name: sleuth-review
description: Review links in a words_to_data dataset — confirm, refute, or dispute machine-suggested legislature.amended_by links, prioritising outdated links, elimination-chosen links, OLRC-sourced addresses, multi-cause changes, and sampling strong links. Use when asked to review, audit, or verify amendment links for a bill.
---

# Review links

You are auditing machine-suggested links in a `words_to_data` dataset. This is
Job 3 of the playbook: read `../references/working-a-dataset.md` (relative to
this skill directory) fully before acting.

## Procedure

1. Run the three queues first — they say what to look at, in the order the
   method trusts least:
   1. `w2d_section_agreement` — per window, how many links agree, disagree, or
      could not be read, then the suspects weakest first. "Could not be read"
      is a limit of the reader rather than a fault in the link, and it is also
      where wrong links hide: read these before the heuristics below. Narrow
      with `bill`, `path`, `from`/`to`.
   2. `w2d_contradictions` — one subject linked in more than one window
      (duplication) or linked to different objects (disagreement). Two laws can
      each be responsible for part of one change, so this is a queue, not a
      fault list.
   3. `w2d_redesignation_report` — the renumberings the bills state, weakest
      first, with why each was not placed. A `renumbering` link is the weakest
      kind, and a renumbering echo makes a later window report changes that
      never happened.
2. `w2d_annotations` with `json: true` for the bill. Each link carries
   `recorded.chosen` (quoted_words | inside_placed_provision | renumbering |
   elimination), `recorded.address_source` (markup | olrc),
   `recorded.changes_under_address`, `causes`, and `outdated`.
3. Review in this order:
   1. **outdated** links (the current batch version no longer makes them) —
      refute if the amendment's words and the changed words disagree; confirm
      if they agree, and then report it as a method regression with the link
      id and both versions, so a person can file it.
   2. links chosen by **elimination**;
   3. links whose address came from the **OLRC** table;
   4. links whose change has **more than one cause**;
   5. quoted-words links under an address holding **many** changes;
   6. a small sample of the strongest kind (quoted words, one change) so the
      report can state how often strong links are right.
4. **Start every review** by comparing the amendment's quoted words with the
   words that changed — `w2d_settle --link <id> --explain` prints both, plus
   the OLRC classification and how the link was made. A link whose changed
   words have nothing to do with the amendment (a renumbered footnote marker,
   a sibling's punctuation change) is the error this review most wants caught.
   `inside_placed_provision` links pointing at a sibling amendment's new
   paragraph are a known error shape.
5. Verdicts with `w2d_settle` (`confirmed` | `refuted` | `disputed`,
   `--reviewer agent:sleuth`, a reason quoting the evidence). A link is right
   when the struck text was there before and gone after, the inserted text is
   there after, and the provision is the one the amendment names.
   - Right but incomplete → **confirm**, then add the missing path with
     `w2d_link_amendment`.
   - Two causes, each visibly responsible for part of the new words → right
     for each cause whose words you can see.
   - Refuting an amendment's only link puts it back on the work list: resolve
     it (see the sleuth-residue skill) or record that it has no link.

## Hard rules

- A link is **never edited** — a review is its own record; the newest wins.
- Writes require the session grant (`/dataset <path> --write`); never write to
  an ungranted dataset.
- Commands first; `w2d_sql` only for gaps, every peek gets a `w2d_gap_record`.

## Report

Per the playbook: each verdict with its link id and evidence; each link left
alone and why; method regressions under "open"; command gaps (include
`/sleuth-gaps` output).
