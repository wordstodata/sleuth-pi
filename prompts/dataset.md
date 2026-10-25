---
description: Register a words_to_data dataset and print what it holds
---

Register the dataset `$ARGUMENTS` (path to the SQLite file) with the
`w2d_dataset` tool, then orient with `w2d_info`, `w2d_expressions`,
`w2d_bills`, and `w2d_validate`.

If the user explicitly said this dataset may be modified, ask THEM to run
`/dataset <path> --write` themselves — the agent cannot grant write access
(`w2d_settle --verdict` and `w2d_link_amendment` refuse without it) and must
never ask around that gate.

Report back, briefly:

- which works and release dates the dataset holds
- which bills it carries, with the public law each became, and its amendments
  and linked amendments from `w2d_bills`
- links by kind and review state from `info`
- methods run per window, and anything `validate` faults or says nobody has run
