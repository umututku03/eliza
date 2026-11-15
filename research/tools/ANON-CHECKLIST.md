# Anonymized artifact checklist (double-blind submission)

The scripts in this folder build and check an anonymized copy of the research artifact. They only read the repository and never upload anything.

## Run

```bash
research/tools/make-anon-artifact.sh                  # new folder under $TMPDIR
research/tools/make-anon-artifact.sh /path/outside/repo/anon-out
research/tools/check-anon.sh <OUT>/artifact [allow.txt]
```

`<OUT>/artifact/` is the upload candidate. `<OUT>/SCRUB-REPORT.txt` is for the authors only: it lists every replacement by file, line and pattern class, the excluded paths, the manual-review items and the `check-anon.sh` result. Do not upload it.

Optional settings: `ANON_EXTRA_TERMS="Name1:Name2"` or an untracked `research/tools/anon-terms.local` file (one term per line) adds identity terms. `ANON_NOTES` changes which notes are included, `ANON_REF` sets the exported commit (default `HEAD`) and `ANON_FRAMEWORK_BASE` sets the upstream ElizaOS base (default `6b6df2f254`).

## What the scripts cover

- **Contents.** Committed files only, exported with `git archive` from `ANON_REF`. Included paths: `research/agent-harness-v2/`, `research/benchmark/`, `research/plan-guard/`, `research/README.md` and, from `research/notes/`, `chain-faults-spec.md`, `evidence-layer-spec.md` and `framework-changes.md`. `workstreams-spec.md` is left out because it describes the internal process (branches, agents, budgets) and is not needed to reproduce the results. The scripts drop `results-*`, `node_modules`, `.env*`, `*.log`, `.git`, `build/`, `__pycache__`, keys and `.DS_Store`.
- **Framework.** The ElizaOS monorepo is not copied. `framework/FRAMEWORK-FILES.txt` names the public upstream base commit, the `@elizaos/*` packages the harness imports, and the changed files under `packages/` and `plugins/` with their line counts. `framework/framework-changes.patch` holds the full diff, with blob `index` lines removed.
- **Scrubbing.** Applies to Markdown/text files and to comments (including Python docstrings) in code. Replacements:
  - GitHub owner/repo and URLs → `ANON_REPO` / `ANON_REPO_URL`
  - local identity terms → `ANON_AUTHOR`
  - "Spartan"/"spartan-agent" → `ANON_AGENT` / `ANON_REPO`
  - emails → `ANON_EMAIL`
  - `/Users/<name>` and `/home/<name>` → `$HOME`
  - `/private/tmp/claude-*` and `/var/folders/*` → `$TMPDIR/...`
  - `Co-Authored-By`/`Signed-off-by` lines → `[attribution removed]`
  - named copyright lines → `ANON_AUTHORS`

  Identity terms are not hard-coded. They come from git `user.name`/`user.email`, the GitHub owners of the remotes, the login and full name of the current user, `ANON_EXTRA_TERMS` and `anon-terms.local`. Public owners such as elizaOS, Uniswap and foundry-rs are allowlisted.
- **Code semantics.** Matches in code or data (string literals, JSON, lockfiles, the patch) are never changed. They are listed under *Manual review*. The comment detector tracks quotes per line, so a comment marker inside a multi-line template string could be misclassified. Check the diff of any scrubbed code file if in doubt.
- **Secrets (fail closed).** The build stops if it finds any of the following:
  - `sk-ant-…` or `sk-…` provider keys
  - GitHub or AWS tokens
  - Alchemy/Infura/QuickNode/Ankr URLs with keys
  - PEM private keys
  - `*_API_KEY=`-style assignments
  - 64-hex values on key-related lines, except the ten well-known Anvil dev keys

  Output names file:line:class only, and the partial output is deleted. Obviously synthetic test fixtures (sequential or repeated bodies, "placeholder", "example") are listed for manual confirmation instead.
- **Manual-review hints.** Commit-hash-like tokens, branch-like names, soft-identity wording (supervisor, course, university) and relative links to files left out of the artifact.
- **Integrity.** `artifact/MANIFEST.sha256` holds SHA-256 values for every file (`shasum -a 256 -c MANIFEST.sha256` from inside `artifact/`).
- **`check-anon.sh`.** Re-scans any directory for every identity and secret class and for forbidden files. It exits non-zero on any finding. Reviewed findings can be accepted in an allow file kept outside the artifact (`file:line:class` per line).

## Check by hand before upload

1. **Manual-review items in `SCRUB-REPORT.txt`.** Resolve each one. Known item: `research/agent-harness-v2/fork-oracle.ts` derives the fork test key from a seed string that contains the codename. Changing it changes the agent address and so the recorded episodes. Either keep it and accept it in the allow file, or change the seed and rerun every result that depends on the address.
2. **Commit hashes in text.** Hashes of the public fork can be searched on GitHub and lead to the authors. Remove or neutralize them in the artifact, the paper and the figures. The upstream ElizaOS base hash is public and safe.
3. **Branch names** (`research/…`, `ws/…`) in the artifact, the paper and figure captions.
4. **The ElizaOS fork URL.** Do not cite the fork (`github.com/<owner>/eliza`) anywhere. Cite upstream ElizaOS plus the anonymous artifact link.
5. **Paper PDF metadata.** Check with `exiftool paper.pdf` or `pdfinfo paper.pdf`: Author, Creator, Producer, Title, XMP. In LaTeX, set `\hypersetup{pdfauthor={},pdfcreator={}}`. Remove `\author`, acknowledgements, funding and "our previous work" self-citations, or cite them in the third person.
6. **Figure text and embedded files.** Check plots and diagrams (SVG/PDF/PNG metadata, axis labels, terminal screenshots with usernames, paths or prompts). Check notebook outputs if any are added.
7. **Broken links.** `research/README.md` and `framework-changes.md` link to files that are not in the artifact (`OVERVIEW.md`, the backlog, framework sources). Either accept them or add a short artifact README.
8. **Tool and process wording** ("written by Claude", "Codex fills in") does not identify the authors, but it can be trimmed for a cleaner artifact.
9. **Rerun `check-anon.sh`** on the exact directory or zip you upload, then spot-read a few files.

## Upload target (not done by these scripts)

Suggested: [anonymous.4open.science](https://anonymous.4open.science). It mirrors a GitHub repository with identity terms masked and serves it at an anonymous URL. Push only `<OUT>/artifact/` to a fresh private repository with a neutral name and squashed history, not the public fork. Alternatives: a zip in the submission system's supplementary material, or a fresh anonymous Zenodo/OSF deposit with all metadata blank. Only the authors upload, after the checks above. These scripts never contact any service.
