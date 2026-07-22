# PLAN: Adapt release task from ../ree-web (open-source mirror release)

## Goal

Replace the current `reelease`/archive-based release flow with the `../ree-web`
style filtered-directory mirror flow, since reepolee-dev is now open source and
distributed as a git repo (`../reepolee`), not a tar.gz archive.

## Current state (reepolee-dev)

- `scripts/release.ts` bumps `package.json` version, commits/pushes it, then
  shells out to a sibling `../reelease` project (`bun ../reelease/index.ts
  --project reepolee`) which builds a tar.gz archive using `.releaseignore`.
- `.releaseignore` is written with "tar.gz release" framing/comments.
- `../reepolee` already exists as an empty git repo (just `.git/`, no remote,
  no files) - a fresh public checkout waiting for its first mirror.
- `config/*.override.ts` files with `@release-sync-hash:` comments already
  exist (e.g. `config/supported_languages.override.ts`), so the override/hash
  mechanism used by ree-web's `release_files.ts` is already compatible with
  this repo's conventions.
- `.reesyncignore` exists at root and must be preserved (untouched by
  `.releaseignore`, per ree-web's convention of keeping it in the public
  output).
- `lib/port_release.ts` is unrelated (dev-server port killer) - not part of
  the release flow, no changes needed.

## Reference implementation (../ree-web)

- `scripts/release.ts` - entrypoint. `--dry-run` prints entry count; without
  it, asserts the public checkout (`../reeweb`) has no uncommitted changes,
  then stages and mirrors.
- `scripts/release_files.ts` - core logic:
  - Parses `.releaseignore` (gitignore-style patterns: `#` comments, `!`
    negation, `dir/`, `**`, anchored `/pattern`).
  - Walks the source tree, skipping ignored paths and any `*.override.*`
    files (these are merged in, not copied verbatim).
  - Validates override hashes: each `foo.override.ts` may carry a
    `// @release-sync-hash: <sha1>` comment recording the hash of `foo.ts` at
    the time the override was authored; if the current `foo.ts` hash no
    longer matches, the release throws ("Override is stale") so stale
    overrides don't silently ship.
  - Stages all release files into a temp dir, substituting override content
    (with the hash comment line stripped) for any file that has one.
  - Mirrors the stage into the public dir: deletes everything in the public
    dir except `.git`, then copies the staged tree in.
- No `git_releases.ts` / no version-bump-and-push in ree-web's version - it
  only stages and stops, deliberately leaving commit/push in the public repo
  to a manual step ("Review ../reeweb, then commit and push it manually when
  ready.").

## Adaptation for reepolee-dev

1. **Add `scripts/release_files.ts`** - copy ree-web's file verbatim (it's
   already generic: takes `source_dir`, `public_dir`, `dry_run` as
   parameters). No reepolee-specific changes needed inside this file.

2. **Rewrite `scripts/release.ts`**:
   - Drop the `../reelease` shell-out entirely (leave the `../reelease`
     project itself untouched - other projects may still use it).
   - Keep version bumping: this repo's release *should* bump
     `package.json`'s version and commit/push that bump to reepolee-dev's
     own `origin main`, unlike ree-web's script (which never wires its
     `bump_patch_version` export into anything). Keep the existing
     `read_project_version` / `write_project_version` /
     `commit_and_push_version` logic from the current `scripts/release.ts`.
   - `PUBLIC_PROJECT_DIR` = `resolve(PROJECT_ROOT, "..", "reepolee")`.
   - Flow for `bun release`: bump+commit+push reepolee-dev's own version,
     then assert `../reepolee` has a clean git checkout, then
     stage-and-mirror the filtered files into it, then print "Review
     ../reepolee, then commit and push it manually when ready." (commit/push
     of the *public* repo stays manual, per confirmation).
   - `--dry-run`: skip the version bump/commit/push and the clean-checkout
     assertion; just print "Would stage N release entries".

3. **Keep `scripts/release.test.ts`** for `format_release_version` /
   `bump_patch_version` (still used by the version-bump step).

4. **Rewrite `.releaseignore`**:
   - Update header comment: no longer "tar.gz releases" / "reelease app" -
     instead "patterns for files excluded from the public open-source
     mirror (`../reepolee`)".
   - Keep all existing exclusion patterns (node_modules, dist, .git, .env,
     IDE files, logs, caches, agent/helper dirs, runtime data, `sl.json`
     translations, source maps).
   - `.releaseignore` itself must stay excluded (already is).
   - Decide: does `.reesyncignore` need to stay out of `.releaseignore`'s
     excludes (so it ships in the public repo, per ree-web's convention)?
     Check current `.releaseignore` - it doesn't mention `.reesyncignore`
     at all, so it already ships by default. No change needed there.
   - Drop `.releaseignore.override` - not present in reepolee-dev, ree-web's
     one just demonstrates a stricter production variant; not needed here
     unless requested.

## Confirmed answers

1. `bun release` bumps reepolee-dev's own `package.json` version and
   commits/pushes that bump to `origin main`, same as the current script.
2. Commit/push of the mirrored public repo (`../reepolee`) stays manual -
   the script only stages/mirrors and prints a reminder.
3. `../reelease` sibling project is left untouched.
