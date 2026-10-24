# SLEUTH: **S**tructured **L**egal **E**xamination **U**sing **T**racked **H**istories.

A [pi package](https://github.com/earendil-works/pi) that turns pi into a legal
research agent over [words-to-data](https://github.com/wordstodata/words-to-data)
datasets: US Code release points, public laws, the amendments that connect them,
and the reviews that vouch for those links.

## Quick start

These steps give you SLEUTH and an example dataset. You need
[Rust](https://rustup.rs), `curl`, `zstd` and 6 GB of free disk space.

1. Install [words-to-data](https://github.com/wordstodata/words-to-data). Until
   version 0.4.1 is on crates.io, install it from GitHub: version 0.4.0 does not
   have the `opinions` command that SLEUTH uses.

   ```bash
   cargo install --git https://github.com/wordstodata/words-to-data
   ```

2. Install [pi](https://github.com/earendil-works/pi). The installer also
   installs Node.js when it is necessary.

   ```bash
   curl -fsSL https://pi.dev/install.sh | sh
   ```

3. Install SLEUTH into pi.

   ```bash
   pi install git:github.com/wordstodata/sleuth-pi
   ```

4. Download the example dataset (280 MB), check it, and decompress it (5.3 GB).
   On macOS, use `shasum -a 256 -c` in place of `sha256sum -c`.

   ```bash
   curl -fLO https://wordstodata.com/assets/wordstodata-example.sqlite.zst
   curl -fLO https://wordstodata.com/assets/wordstodata-example.sqlite.zst.sha256
   sha256sum -c wordstodata-example.sqlite.zst.sha256
   zstd -d wordstodata-example.sqlite.zst -o example.sqlite
   ```

5. Start pi in the same directory. Type `/login` to connect a model with a
   subscription or an API key. Then open the dataset and ask a question:

   ```
   pi
   /login
   /dataset example.sqlite
   Where in the Internal Revenue Code is the new Trump account section, and in which printing of the Code does it first appear?
   ```

The session is read-only. SLEUTH finds the section from the words alone, and it
shows the evidence. A real answer (2026-10-23), cut:

> **Where:** the new Trump account section is **26 U.S.C. § 530A ("Trump
> accounts")**, in a brand-new **part IX ("TRUMP ACCOUNTS")** added at the end of
> subchapter F of chapter 1:
> `uscode/title_26/subtitle_A/chapter_1/subchapter_F/part_IX/section_530A`
>
> **First printing:** the **2025-07-30** printing of Title 26. `w2d_path` reports
> the section present at 2025-07-30, 2025-08-14, 2026-01-23 and 2026-07-12, … a
> search for "Trump account" at 2025-07-18 returns 0 fields.
>
> **Source:** OLRC classifies `part_IX/section_530A` as new from **Pub. L. 119-21
> § 70204(a)(1)** (bill 119-hr-1) …

Then ask more questions, for example:

- What does 26 U.S.C. § 280C(c)(1) say now, and what did it say before the One Big Beautiful Bill Act changed it?
- In Boeing Co. v. United States, what did Justice Thomas say at 537 U.S. 459, and which Code sections does his dissent cite?
- BMW (US) Holding Corp. v. United States (Court of Federal Claims, August 2026) cites the bonus depreciation rule, 26 U.S.C. § 168(k). Has § 168(k) changed since the decision?

The example dataset holds:

- **The U.S. Code**, every title, at 5 printings: 2025-07-18, 2025-07-30,
  2025-08-14, 2026-01-23 and 2026-07-12.
- **7 bills of the 119th Congress**, with their amendments linked to the changes
  in the Code, and the House roll calls. Two of them are H.R. 1 (Pub. L. 119-21,
  the One Big Beautiful Bill Act) and S. 1071 (the NDAA for FY2026, Pub. L. 119-60).
- **45 court writings in 28 cases**, with pages, paragraphs, footnotes and their
  citations of the Code.

SLEUTH finds the `words_to_data` binary through `W2D_BIN`, then
`~/words-to-data/target/release/words_to_data`, then `PATH`. `cargo install`
puts it in `~/.cargo/bin`, which is on `PATH` after a usual Rust install.

## What it adds

**Tools** (`extensions/w2d.ts`) — one per `words_to_data` subcommand:
`w2d_info`, `w2d_expressions`, `w2d_bills`, `w2d_opinions`, `w2d_validate`,
`w2d_search`, `w2d_diff`, `w2d_path`, `w2d_annotations`, `w2d_residue`,
`w2d_amendment_addresses`, `w2d_section_agreement`,
`w2d_redesignation_report`, `w2d_contradictions`, `w2d_cases_citing`,
`w2d_coverage`, `w2d_release_points`, `w2d_show_bill`, `w2d_votes`,
`w2d_settle` (explain + verdict),
`w2d_link_amendment`, and `w2d_raw` as the read-only escape hatch. Tool
descriptions encode the playbook's traps (renumbering echoes, the lying
`WITH CHANGES` column, parent paths hiding children, "could not be read" being
the reader's limit).

**Fetch** (`w2d_fetch`) — `add-bills` (Congress.gov) and `add-opinions`
(CourtListener) are the only networked commands; they need `CONGRESS_API_KEY` /
`COURTLISTENER_API_KEY` in the pi process environment and the session write
grant. Batch steps (`add-classifications`, `link-by-evidence`, `redesignations`)
stay human-run in the terminal.

**Read-only SQL** (`extensions/w2d-sql.ts`) — `w2d_sql` peeks at the dataset
with Node's built-in SQLite (`mode=ro`, SELECT-only). The commands are the
contract: when no command answers a question and SQL is the fallback, the
answer must be recorded with `w2d_gap_record`, and the gap list (viewable with
`/sleuth-gaps`) becomes the findings section of the end-of-run report and a
future issue list for words-to-data. A gap must be backed by a query that ran:
its SQL is matched against every `w2d_sql` call of the session, with white
space and a trailing semicolon ignored, and a gap that matches none is kept
with a note that says so.

**The write gate** (`extensions/w2d-guard.ts`, `src/w2d-common.ts`) —
`/dataset <path> [--write]` registers the dataset; writes (`settle --verdict`,
`link-amendment`, `w2d_fetch`) are refused in code unless the session was
granted `--write`. The grant never survives `/new`. `w2d_raw` runs the
read-only subcommands only: every writer is refused there even with the grant
(the typed tool is what validates a verdict), `settle` passes with `--explain`
alone, and the batch steps and builders (`link-by-evidence`, `redesignations`,
`add-classifications`, `build-dataset`, `convert-dataset`, `add-release-points`,
`declare`) are refused outright
— a build takes its output path where the runner puts the dataset in force.
`test/w2d-common.test.ts` pins that gate (`npm test`).

**Skills** — the three jobs of
`skills/references/working-a-dataset.md` (the words-to-data playbook, playbook
version 1, copied verbatim — do not fork it here, change it upstream and
re-copy): `sleuth-answer` (answer a question, including case law),
`sleuth-residue` (resolve the amendments the batch could not link, starting at
`amendment-addresses`), `sleuth-review` (audit links, starting from the
`section-agreement` and `contradictions` queues, then outdated → elimination →
OLRC address → multi-cause → sampled strong), and `sleuth-build` (build or
extend a dataset, and the human-run batch steps in between).

## What no command answers

The dataset holds these and no `words_to_data` command prints them, so they are
`w2d_sql` peeks each recorded with `w2d_gap_record` (and upstream issues):

- who sponsored or cosponsored a bill, and when (`sponsors` table;
  `w2d_bills` prints only ids and amendment counts)
- how one member voted, or a roll call across a whole congress
  (`member_votes`, `roll_calls`; `w2d_votes` counts by party)
- a member's party, state, district or terms (`members`)

A dataset without a declaration cannot separate "not found" from "out of
scope". A person sets one with `words_to_data declare`; it writes, so there is
no tool for it, and `w2d_raw` refuses it as it refuses `add-release-points`.
`w2d_release_points` lists the dates those take.

**Prompts** — `/dataset <path>` orients on a new dataset; `/report` writes the
playbook's end-of-run report including the gap list.

## Install

An ordinary pi package: resources are discovered from the conventional
`extensions/`, `skills/` and `prompts/` directories, so there is deliberately
no `pi` manifest key — a partial `pi` manifest replaces conventional discovery
for every resource type, so declaring only `extensions` would silently drop the
skills and prompts. There are no runtime dependencies: pi supplies
`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, which
`peerDependencies` declares, and `w2d_sql` uses Node's built-in `node:sqlite`
(Node >= 22.19, matching pi's own floor).

```bash
pi install npm:sleuth-pi                                    # once published
pi install git:github.com/wordstodata/sleuth-pi              # from this repo
pi install /path/to/sleuth-pi                               # from a checkout
pi list                                                     # 3 extensions, 4 skills, 2 prompts, 25 tools
pi -e /path/to/sleuth-pi                                    # one invocation, nothing persisted
```

`package.json` is `private` until the npm publish is wanted; installing from
GitHub needs nothing but pi. pi installs managed packages with
`--omit=dev --omit=peer`, so the devDependencies below never reach an install.

## Development

```bash
npm install --ignore-scripts   # pi packages + typescript, for type-checking only
npm run check                  # against the published pi packages (what CI runs)
npm run check:checkout         # against a pi checkout sitting at ../packages
npm test                       # node --test; the dataset tests need W2D_DATASET and W2D_BIN
W2D_DATASET=~/words-to-data/dataset-demo.sqlite \
W2D_BIN=~/words-to-data/target/release/words_to_data npm test
```

The dataset tests skip themselves without those two variables; a few of them
run slow commands (`validate`, `redesignation-report`), so a full run over the
demo dataset takes a couple of minutes. The gap ledger test needs neither: it
makes a small SQLite file of its own.

## Use

```
/dataset ~/words-to-data/dataset-demo.sqlite        # read-only
/dataset ~/working-copy.sqlite --write              # only when told this dataset may change
```

Then ask, e.g.:

- `What changed in Title 26 between 2025-07-18 and 2025-07-30, and which
  public law did it?` (loads sleuth-answer)
- `Resolve the residue of 119-hr-1` (loads sleuth-residue; needs --write)
- `Review the links on 119-s-1071` (loads sleuth-review; verdicts need --write)
- `Which opinions cite 26 U.S.C. § 174, and did it change after they were
  filed?` (loads sleuth-answer; `w2d_cases_citing --chain` reaches the sponsor)
- `Add release point 2026-07-12 and the bills 119-hr-998, 119-s-1071`
  (loads sleuth-build; needs --write, and the batch steps are the user's)

Environment defaults: `W2D_DATASET` (dataset path), `W2D_BIN` (binary path;
without it the release binary at `~/words-to-data/target/release/words_to_data`
is used when present, otherwise `words_to_data` from PATH).

## Layout

```
sleuth-pi/
├── package.json              # peerDeps on the pi packages; no runtime deps
├── tsconfig.check.json       # type-check against the published pi packages
├── tsconfig.checkout.json    # type-check against a pi checkout at ../packages
├── extensions/
│   ├── w2d.ts                # the w2d_* tools
│   ├── w2d-sql.ts            # read-only SQL peek + the gap ledger
│   └── w2d-guard.ts          # /dataset, the write gate
├── src/
│   └── w2d-common.ts         # binary/dataset resolution, CLI runner, the w2d_raw gate, addFlags
├── skills/
│   ├── references/working-a-dataset.md   # copied from words-to-data docs
│   ├── sleuth-answer/SKILL.md
│   ├── sleuth-build/SKILL.md
│   ├── sleuth-residue/SKILL.md
│   └── sleuth-review/SKILL.md
├── test/
│   ├── tools.test.ts         # tool registration, schema shape, real-dataset calls
│   └── w2d-common.test.ts    # the write gate, flag building, output bounding
└── prompts/{dataset,report}.md
```

## Notes

- `skills/references/working-a-dataset.md` is a copy of the words-to-data
  playbook. Re-copy it when the upstream doc changes (it is versioned:
  "Playbook version 1"; the method name `resolve-residue@1` must track it).
- The tools shell out to the `words_to_data` binary; nothing here reads the
  dataset except through `w2d_sql`.
- There is deliberately **no `tsconfig.json`**. pi loads `.ts` extensions
  through jiti with `tsconfigPaths` on, and jiti reads the nearest
  `tsconfig.json` from the extension's directory upward. A config here would
  change how `@earendil-works/*` and `typebox` resolve at load time, and with a
  second copy of `typebox` in `node_modules` that is how a `Type.Optional`
  parameter silently becomes required: pi validates tool arguments with its own
  TypeBox copy, which reads optionality off a symbol only its own copy stamps.
  The two type-check configs are named `tsconfig.check*.json` so jiti never
  sees them.
- `Type` and `StringEnum` are imported from `@earendil-works/pi-ai`, not
  `typebox`, for the same reason: pi re-exports `Type` from its own copy, so the
  schemas are built with the copy that validates them. `typebox` is a
  devDependency only, to type-check that re-export.
- `src/` is not a conventional resource directory: only `extensions/*.ts` is
  loaded as an extension, so the shared helpers there are plain imports.
- `npm test` runs `node --test test/*.test.ts`. It imports the extensions, so
  `npm install --ignore-scripts` has to have run; no pi checkout is needed.
- Every tool was checked against `dataset-demo.sqlite` (65 works, 297
  expressions, 6248 links). `w2d_cases_citing` needs opinions in the dataset:
  `w2d_fetch` adds them, and the command says when the dataset holds none.
