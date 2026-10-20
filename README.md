# SLEUTH — **S**tructured **L**egal **E**xamination **U**sing **T**racked **H**istories.

A [pi package](https://github.com/earendil-works/pi) that turns pi into a legal
research agent over [words-to-data](https://github.com/Scronkfinkle/words-to-data)
datasets: US Code release points, public laws, the amendments that connect them,
and the reviews that vouch for those links.

## What it adds

**Tools** (`extensions/w2d.ts`) — one per `words_to_data` subcommand:
`w2d_info`, `w2d_expressions`, `w2d_bills`, `w2d_validate`, `w2d_search`,
`w2d_diff`, `w2d_path`, `w2d_annotations`, `w2d_residue`,
`w2d_amendment_addresses`, `w2d_section_agreement`,
`w2d_redesignation_report`, `w2d_contradictions`, `w2d_cases_citing`,
`w2d_coverage`, `w2d_show_bill`, `w2d_votes`, `w2d_settle` (explain + verdict),
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
future issue list for words-to-data.

**The write gate** (`extensions/w2d-guard.ts`, `src/w2d-common.ts`) —
`/dataset <path> [--write]` registers the dataset; writes (`settle --verdict`,
`link-amendment`, `w2d_fetch`) are refused in code unless the session was
granted `--write`. The grant never survives `/new`. `w2d_raw` runs the
read-only subcommands only: every writer is refused there even with the grant
(the typed tool is what validates a verdict), `settle` passes with `--explain`
alone, and the batch steps and builders (`link-by-evidence`, `redesignations`,
`add-classifications`, `build-dataset`, `convert-dataset`) are refused outright
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

Two more gaps belong to `words_to_data` itself: no command lists the release
points the mirror carries (`build-dataset --uslm-dates` needs dates you already
have), and only `build-dataset --declaration` can set a declaration, so an
existing dataset can never gain one and `w2d_info` then cannot separate "not
found" from "out of scope".

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
pi install github:wordstodata/sleuth-pi                     # from this repo
pi install /path/to/sleuth-pi                               # from a checkout
pi list                                                     # 3 extensions, 4 skills, 2 prompts, 24 tools
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
demo dataset takes a couple of minutes. Recording a gap writes, so that one
assertion needs `W2D_ALLOW_WRITE=1` and runs against a copy of the dataset.

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
