---
name: sleuth-build
description: Build or extend a words_to_data dataset — add US Code release points, Congress bills, or CourtListener opinions, and bring the dataset to a linked, validated state. Use when asked to create a dataset, add a release date, add a bill or public law, add court opinions, or report why a dataset is not linked yet.
---

# Build or extend a dataset

You are changing a dataset, which is the one job that writes something other
than a link or a review. Read `../references/working-a-dataset.md` (relative to
this skill directory) for what a linked dataset means and how `residue` and
`coverage` say it is unfinished.

## Who runs what

The write gate holds you to this. Ask the user to run `/dataset <path> --write`
before any of it, and never around it.

| Step | Who runs it |
| --- | --- |
| `build-dataset --uslm-dates <dates> <output>` | a person, in the terminal |
| `w2d_fetch` with `bills` (Congress.gov, `CONGRESS_API_KEY`) | you, with the grant |
| `w2d_fetch` with `opinions` (CourtListener, `COURTLISTENER_API_KEY`) | you, with the grant |
| `add-classifications` (the OLRC's classification of each public law) | a person |
| `link-by-evidence` (the batch that makes the links) | a person |
| `redesignations --bill-id <bill> --between <d1> <d2>` | a person, per bill |
| `convert-dataset` (compact JSON ↔ SQLite) | a person |
| `add-release-points --uslm-dates <dates>` | a person |
| `declare <dataset> <declaration.json>` (what the dataset is meant to cover) | a person |
| `carry-reviews <new dataset> --from <old dataset>` (after a rebuild) | a person |

`w2d_raw` refuses every one of those by name and tells you so. That refusal is
the design, not a wall to go around: the batch steps rewrite links and the
builders take their output path where the runner would put the dataset in
force. Ask the user to run them and paste the output.

## Order

1. `w2d_info` and `w2d_validate` first: what the dataset holds, which methods
   have run over which windows, and what nobody has run.
2. Add the material. `w2d_fetch` with `bills` (Congress ids) or `opinions`
   (CourtListener opinion ids); `offline: true` reads the shared cache and
   never the network, and `cacheDir` moves it. Each opinion id becomes a
   writing, `judicial/case_<cluster>/opinion_<id>`, of its case's work
   `judicial/case_<cluster>`. When the publisher holds a case only as one
   combined record, a rule can split it into several writings,
   `…/opinion_<id>-1`, `-2`, …, and a "found by:" line names the rule.
   `w2d_opinions` lists them, and `w2d_cases_citing` reads their citations.
3. Ask for the batch steps in this order: `add-classifications`, then
   `redesignations` for each bill added and each window, then
   `link-by-evidence`. The matcher reads the renumbering links first, so
   `redesignations` must run before it.
4. After a rebuild, run `words_to_data carry-reviews <new dataset> --from <old dataset>`.
   It carries each review of a citation link to the new links that say the
   same thing, and it lists each review that it could not carry, with the
   reason. A rebuild gives every citation link a new id, so without this step
   the reviews of the old dataset are lost. A carried review is an ordinary
   review, and `w2d_settle` (explain) reports it.
5. Re-check: `w2d_info` (links by kind, review state, methods run),
   `w2d_validate` (faults, unrun steps), `w2d_coverage` over each new window
   (what no link claims), `w2d_residue` per bill (what the batch could not
   link — that is the sleuth-residue skill).

## Release points and the declaration

- **`w2d_release_points` lists the release points** the mirror offers and the
  cache holds (`offline: true` reads the cache alone). Give the user the dates
  it lists for `build-dataset` or `add-release-points` (`--uslm-dates`, as
  comma-separated `YYYY-MM-DD`).
- **A dataset without a declaration cannot say "out of scope".** `w2d_info`
  then prints `Covers:` with no `Declared:` block, so an empty answer means
  only "not found". A person sets a declaration with
  `words_to_data declare <dataset> <declaration.json>`. Until then, say in
  every report that relies on absence that the dataset declares nothing.

Datasets are SQLite. A compact-JSON dataset cannot be written in place (the CLI
refuses) and `w2d_sql` cannot open one: have a person run `convert-dataset`
first, or pass `output` on a write to produce a new JSON file.

## Hard rules

- Writes need the grant. Refuse yourself before the tools do.
- Never overwrite a dataset that was not built for this: a build or a convert
  into an existing path is a person's decision, not yours.
- Report what you ran, what the user ran, what `w2d_validate` still says
  nobody has run, and whether the dataset declares what it covers.
