---
name: release
description: Cut a new Tenna release — decide the version, write the changelog entry, tag, and push so CI builds the signed APK and republishes the nsite. Triggered by "publish a new release" or similar requests.
---

# Release Skill

This skill guides you through publishing a new release of Tenna: choosing the version, writing the changelog entry, and tagging and pushing so CI does the rest.

## Overview

- **Version format**: Marketing version (X.Y.Z). **This is NOT semver.** The number is chosen by how the release looks to somebody using the app, not by API compatibility or breaking changes. Think of it as an app store version — it reflects how significant the update feels to a regular user.
- **Version source of truth**: **the git tag, and nothing else.** Tenna commits no version field anywhere. `.ngit/act/workflows/release.yml` derives both values from the tag and stamps them into the build:
  - `versionName` = the tag minus the leading `v` (`v1.2.0` → `1.2.0`)
  - `versionCode` = `major * 1_000_000 + minor * 1_000 + patch`

  So **do not edit `package.json` or `android/app/build.gradle`** during a release. `package.json`'s `version` is inert template leftover; changing it changes nothing and misleads the next person.
- **Changelog**: `CHANGELOG.md` in the repo root, [Keep a Changelog](https://keepachangelog.com/) format. Nothing in CI reads it — it is the human record of the release and the source of the announcement text. Create it on the first release if it does not exist.
- **Version bumping**:
  - **Patch (Z)**: Most releases. Bug fixes, tweaks, internal improvements — anything a user wouldn't specifically notice or seek out.
  - **Minor (Y)**: Releases with a headline feature — something worth announcing. A user should look at the bump and think "oh, something new happened."
  - **Major (X)**: Only when the user explicitly asks (milestones, rebrands, major redesigns).
- **CI trigger**: pushing a `vX.Y.Z` tag runs `release.yml` (signed Android APK → Zapstore). The push to `main` carrying the same commit runs `deploy-nsite.yml`, which republishes the web client as the nsite. Two workflows, one push — see Step 8.

## Release Procedure

Follow these steps in order. Do NOT skip any step.

### Step 1: Required Reading

Before writing any release notes, read these to get the product and the voice:

1. **`README.md`** — what Tenna is, the wall and the channel conceit, how a site is served, what Android adds.
2. **`NAPP.md`** — the contract Tenna offers site authors, if the release touches anything a site can call.
3. **`git log`** — the house voice. Subjects are short declarative sentences about what the software now does ("Let a site save a file it offers", "Wear the same face in the status bar"), never conventional-commit prefixes and never implementation summaries.

Changelog entries are written in that same voice: plain, concrete, about the thing the user gets. No jargon, no developer framing.

### Step 2: Pre-flight Checks

```bash
# Ensure working directory is clean
git status

# Ensure we're on main branch
git branch --show-current

# Run the full gate: typecheck, lint, unit tests, production build
npm run test
```

- If the working directory has uncommitted changes, ask the user whether to commit them first or abort.
- If not on `main`, warn the user and ask whether to proceed.
- If the gate fails, stop and fix it. The release must not contain broken code.

### Step 3: Determine What Changed

```bash
# The last released version, if there is one
git describe --tags --abbrev=0 --match 'v[0-9]*'

# Commits since it
git log $(git describe --tags --abbrev=0 --match 'v[0-9]*')..HEAD --oneline
```

- **If there are no tags yet**, this is the first release: the whole history is the release window (`git log --oneline`), and the version number is the user's call — ask, rather than assuming `1.0.0`.
- If there are no commits since the last tag, tell the user there is nothing to release and stop.
- Review the commit list to understand the scope of changes.

### Step 4: Decide the Version Bump

| Bump | When to use | Example |
|------|-------------|---------|
| **Patch** | Bug fixes, minor tweaks, dependency updates, small UI polish, internal tooling, CI/build changes, settings screens | 1.0.0 → 1.0.1 |
| **Minor** | Significant new product features that change how somebody uses the app — the kind of thing you'd put in a store update or announce (e.g. a new way to add sites, a new capability sites can call, a redesigned wall) | 1.0.1 → 1.1.0 |
| **Major** | ONLY when the user explicitly instructs a major bump | 1.1.0 → 2.0.0 |

**Default to patch** when in doubt. The bar for a minor bump is high — ask: "Would somebody using Tenna notice and care?" If no, it's a patch. Infrastructure, CI fixes, and developer tooling are always patch-level regardless of how much code moved.

When bumping minor, reset patch to 0 (1.0.3 → 1.1.0). When bumping major, reset minor and patch to 0 (1.3.1 → 2.0.0).

**The tag must be exactly `vMAJOR.MINOR.PATCH`, all numeric, no suffix.** No `v1.2`, no `v1.2.0-rc1`: the release job's "Derive version" step rejects anything else and the release fails before it builds. Minor and patch each have room for 0–999 in the versionCode scheme; going past 999 would collide with the next component.

### Step 5: Write the Changelog Entry

Prepend a new section to `CHANGELOG.md` directly below the `# Changelog` heading. If the file doesn't exist yet, create it with that heading and this as the first section.

**Format:**

```markdown
## [X.Y.Z] - YYYY-MM-DD

A short single-paragraph summary of this release written in plain prose — max 500 characters.

### Added
- Description of new features

### Changed
- Description of changes to existing features

### Fixed
- Description of bug fixes

### Removed
- Description of removed features
```

#### The Summary Paragraph

Every release section MUST start with a single plaintext paragraph (not a bullet, not a heading) summarising the release:

- **Single paragraph, plain prose.** No bullets, no headings, no Markdown beyond plain text.
- **Max ~500 characters.** That is what the Zapstore listing and both app stores allow for "what's new", so writing to it now means the text is reusable as-is.
- **Audience: somebody deciding whether to update.** Describe the most noticeable changes; leave internal cleanups to the bullets, or out entirely.
- **Tone matches the bullets.** Present tense, no protocol jargon (see Rules).
- **Maintenance releases** get a one-sentence summary like `A behind-the-scenes maintenance release with no user-facing changes.` Never leave it blank.

#### Changelog Quality Checklist

Run through this before drafting entries. It is NOT optional — skipping it is the most common way a release goes out with misleading notes.

##### 5.1. Diff the code, not just the commit log

Commit messages describe intent at the moment of commit; they over- and under-represent the cumulative effect at release time. Before drafting entries, **run a real diff** for each area of substantial change:

```bash
# Full diff between tags
git diff v<prev>..HEAD

# Or narrowed to an area you're unsure about
git diff v<prev>..HEAD -- src/components/nsite/
```

Only the diff reveals intra-release churn — commits that cancel out, bugs introduced and then fixed, refactors that land and get reverted. Reading commit messages alone is insufficient.

##### 5.2. Trace every candidate "Fixed" entry to its origin commit

For each bug fix you're considering listing, find the commit that introduced the bug. Tenna has no `Regression-of:` trailer convention, so trace it by hand:

```bash
# The history of a file across the release window
git log --oneline v<prev>..HEAD -- path/to/file.tsx

# Or blame the specific lines the fix touched
git blame -L <start>,<end> -- path/to/file.tsx

# Returns 0 if <sha> is BEFORE v<prev> (pre-existing bug -> legit "Fixed" entry)
# Returns non-zero if <sha> is AFTER v<prev> (intra-release -> omit from "Fixed")
git merge-base --is-ancestor <sha> v<prev>
```

**If the introducing commit is also in this release window, the bug is intra-release.** Nobody on the previous version experienced it. Do NOT list it under "Fixed". Fold it into the relevant "Added" or "Changed" entry, or omit it.

##### 5.3. The "Would somebody on the previous version notice this?" test

The changelog describes the delta between the previous release and this one **from the user's side** — not the development history. For each entry, ask:

> "Did somebody on the previous published version experience this exact thing?"

- They hit a broken state that now works: **"Fixed"**
- They saw the old behaviour and now see new behaviour: **"Changed"** or **"Added"**
- They never saw either state (introduced AND resolved inside this window): **omit entirely**

This applies beyond bugs: a feature added then reverted, a refactor done then undone, a performance regression introduced then fixed — omit both halves. A typo in a brand-new string, corrected before release, gets one "Added"/"Changed" entry for the string and no "Fixed" entry.

##### 5.4. Worked example — intra-release bug

> **Scenario:** Commit A rewrites how a site's window is drawn and, as a side effect, breaks the clock over full-screen video. Commit B, later in the same release window, restores it.
>
> **Correct changelog:** One entry describing the new site window. The clock is part of the finished state the user receives.
>
> **Incorrect changelog:** An "Added" entry for the window AND a "Fixed" entry for the clock. Nobody on the previous version saw the broken clock; listing it invents a problem they didn't have and makes the notes read like a developer changelog.

#### Rules

- Only include categories that have entries (omit empty ones)
- Write **user-facing descriptions**, not raw commit messages
- One line per change, concise
- Group related commits into a single entry where appropriate
- Present tense ("Add a channel number to every tile", not "Added...")
- Focus on what the user sees, not internal implementation
- Current date, YYYY-MM-DD
- **Never use Nostr protocol jargon.** No NIP numbers ("NIP-5A", "NIP-07"), no kind numbers ("kind 35128"), no "Blossom blob", no "bunker". Say the thing in plain language: "Sites can be added by pasting their address" rather than "naddr/nprofile input"; "Sites can ask Tenna to sign" rather than "NIP-07 proxy". The audience is people using an app, not protocol developers. This rule is stricter for Tenna than for most apps precisely because the codebase is protocol-dense — it is very easy to leak vocabulary that means nothing to a user.
- **Only ship what the user sees.** Intra-release churn is invisible to them; omit it (see 5.2 and 5.3).
- **Collapse related work into one entry.** Never list something as "Added" and then also list fixes to that same thing.
- **Omit purely internal changes.** CI, build pipeline, workflows, developer tooling, agent skills — out, unless they visibly change the app.

### Step 6: Do NOT Touch Version Files

There is deliberately nothing to update. The tag is the version (see Overview). If you find yourself editing `package.json`'s `version` or `android/app/build.gradle`'s `versionName`/`versionCode`, stop — CI overwrites the gradle values from the tag on every build, and a committed number that disagrees with the tag is worse than no number.

The only file this release changes is `CHANGELOG.md`.

### Step 7: Pull, Commit, Tag

Pull first, so the release commit sits on top of the latest code and the tag lands on a commit the remote already has.

```bash
git pull origin main
```

**CRITICAL**: always `git pull` (merge), NEVER `git pull --rebase`. Rebasing rewrites hashes and would orphan a tag pointing at the original commit.

Resolve any conflicts before continuing. Then:

```bash
git add CHANGELOG.md
git commit -m "Cut vX.Y.Z"
git tag vX.Y.Z
```

Use a **lightweight** tag, exactly `v` + the version, no suffix — that is what `release.yml` matches (`tags: ["v*"]`) and what its version derivation parses.

### Step 8: Push

```bash
git push origin main vX.Y.Z
```

**CRITICAL**: push only the tag being released. NEVER `--tags` — that pushes every stale local tag.

`origin` is a `nostr://` remote, so this goes through `git-remote-nostr`; make sure `~/.local/bin` is on `PATH` if the push fails with "unable to find remote helper".

**Push `main` and the tag together, in one command.** They must be the same commit:

- the **tag** triggers `release.yml` → signed APK → Zapstore
- the **push to main** triggers `deploy-nsite.yml` → the web client, republished as the nsite

`deploy-nsite.yml` deliberately does not run on tags (act derives a container name from the workflow and job names alone, so the same commit planning it twice would collide and each run would destroy the other's container). The tagged build reaches the nsite through the `main` run, and only if `main` points at the tagged commit.

### Step 9: Confirm

Results appear on gitworkshop.dev against the tagged commit. Tell the user:

- the new version number
- a brief summary of what was released
- that CI is building the APK for Zapstore and republishing the nsite, and where to watch it

## File Reference

| File | What to update | Notes |
|------|---------------|-------|
| `CHANGELOG.md` | Prepend a new section | The only file a release edits |
| `package.json` | **nothing** | `version` is inert; the tag is the version |
| `android/app/build.gradle` | **nothing** | `versionName`/`versionCode` are stamped from the tag by CI |
| `zapstore.yaml` | **nothing per release** | The listing. `version` and `release_source` are prepended by CI so they cannot disagree with the tag. Edit only when the store copy itself changes |

## CI Pipeline

ngit-ci watches `.ngit/act/workflows/` and runs them with `act`. Two are relevant to a release:

1. **`release.yml`** — on `v*` tags. Derives `versionName`/`versionCode` from the tag and stamps them into `android/app/build.gradle`; writes the signing keystore from secrets (and deletes it in the same job, `if: always()`); builds the web assets, `cap sync android`, and a signed release APK; uploads the APK as a run artifact; then publishes it to Zapstore with `zsp` from `zapstore.yaml`, picking the first Blossom server in `.nsite/config.json` that answers a live probe. Build and publish are one job on purpose — act's artifact round-trip returns a 3-byte stub across jobs, which would hand `zsp` an empty APK.
2. **`deploy-nsite.yml`** — on pushes to `main`. Builds the client and publishes it as the named nsite from `.nsite/config.json` via `scripts/nsite-deploy.sh`.

Both need secrets the ngit-ci operator provisions against this repo's alias; each workflow's header names them. They are injected only on maintainer-authored triggers, and a tag push by a maintainer qualifies.

## Troubleshooting

### "Nothing to release"
If `git log` shows no commits since the last tag, there genuinely is nothing to release.

### The gate fails
Fix it before proceeding. `npm run test` is typecheck, lint, unit tests, and the production build.

### Wrong version tagged, not yet pushed
```bash
git tag -d vX.Y.Z          # delete the local tag
git reset --soft HEAD~1    # undo the commit, keep the changes staged
```
Then redo steps 4–7 with the correct version.

### The release job fails at "Derive version"
The tag isn't `vMAJOR.MINOR.PATCH` with all-numeric components. Delete the tag, retag correctly, and push again.

### Zapstore publish hangs or times out
The job kills `zsp` at 900s and says so (exit 124/137). That is almost always an unreachable dependency, not a slow upload — check the bunker signer and each host in `RELAY_URLS`/`BLOSSOM_URL` in the step's traced output. The APK artifact is uploaded *before* the publish, so it is still downloadable from the run.

### Already pushed a bad release
Needs manual intervention. Tell the user; a tag that is already on the remote and in a published Zapstore release can't be quietly reused — the fix is a new patch release.
