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

`w2d_raw` refuses every one of those by name and tells you so. That refusal is
the design, not a wall to go around: the batch steps rewrite links and the
builders take their output path where the runner would put the dataset in
force. Ask the user to run them and paste the output.

## Order

1. `w2d_info` and `w2d_validate` first: what the dataset holds, which methods
   have run over which windows, and what nobody has run.
2. Add the material. `w2d_fetch` with `bills` (Congress ids) or `opinions`
   (CourtListener opinion ids); `offline: true` reads the shared cache and
   never the network, and `cacheDir` moves it. Each opinion becomes one
   expression of a `judicial/opinion_<id>` work, whose text is searchable with
   `w2d_search --work judicial/opinion_<id>` and citable with
   `w2d_cases_citing`.
3. Ask for the batch steps in this order: `add-classifications`,
   `link-by-evidence`, then `redesignations` for each bill added.
4. Re-check: `w2d_info` (links by kind, review state, methods run),
   `w2d_validate` (faults, unrun steps), `w2d_coverage` over each new window
   (what no link claims), `w2d_residue` per bill (what the batch could not
   link — that is the sleuth-residue skill).

## Two things no command does

Say so in your report instead of guessing around them.

- **Nothing lists the release points the mirror carries.** `build-dataset` and
  `add-release-points` take `--uslm-dates` as comma-separated `YYYY-MM-DD`, and
  the mirror index
  (`https://wordstodata.com/mirror/uslm/index.json`, overridable with
  `--mirror-index`) is the only list of them. Ask the user which dates they
  want and have them confirm the mirror carries those dates.
- **No command can give an existing dataset a declaration.** Only
  `build-dataset --declaration <file.json>` sets one. Without it `w2d_info`
  prints `Covers:` with no `Declared:` block and no gaps, so an empty answer to
  any question means only "not found" — never "out of scope". When the dataset
  was built without one, say that in every report that relies on absence.

Datasets are SQLite. A compact-JSON dataset cannot be written in place (the CLI
refuses) and `w2d_sql` cannot open one: have a person run `convert-dataset`
first, or pass `output` on a write to produce a new JSON file.

## Hard rules

- Writes need the grant. Refuse yourself before the tools do.
- Never overwrite a dataset that was not built for this: a build or a convert
  into an existing path is a person's decision, not yours.
- Report what you ran, what the user ran, what `w2d_validate` still says
  nobody has run, and the two gaps above if either bit.
