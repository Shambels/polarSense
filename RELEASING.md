# Releasing

Releasing is three commands. The notes exist because several steps fail with an
error message that does not say what is actually wrong.

    git commit -am "changelog for 0.1.2"   # after editing CHANGELOG.md
    npm version patch                      # tests, bump, commit, tag, package
    git push --follow-tags                 # then upload the .vsix

## 1. Choose the number

Versions are permanent: the Marketplace will never accept the same
`publisher.name@version` twice, so a mistake costs a version number rather than
being fixable.

- **Patch** (`0.1.0` → `0.1.1`) — fixes only.
- **Minor** (`0.1.1` → `0.2.0`) — new features, nothing broken.
- **Major** — a breaking change to settings or behaviour people rely on.

Two extension-specific rules on top of SemVer:

- Only `major.minor.patch` is accepted. SemVer pre-release tags like
  `0.2.0-beta` are **not supported** by the Marketplace.
- VS Code's own convention is `major.EVEN.patch` for stable releases and
  `major.ODD.patch` for the pre-release channel — `0.2.x` stable, `0.3.x`
  pre-release. Nothing enforces it, but users of other extensions read version
  numbers that way.

To ship to the pre-release channel, add `--pre-release` to `vsce package` or
`vsce publish`. Users only get it if they opt in.

## 2. Write the changelog first

`CHANGELOG.md` is the Marketplace's "Changelog" tab, so it is user-facing. Write
it before bumping the version — it is the check on whether the number you chose
matches what actually changed. Group under **Added / Fixed / Changed / Security**,
and describe what a user notices rather than which file moved.

## 3. Bump, test and package — one command

Commit the changelog first: `npm version` refuses to run on a dirty tree.

```bash
npm version patch          # or minor / major / an exact version like 0.1.1
```

Lifecycle hooks in `package.json` do the rest:

- `preversion` runs `npm test`. **A failing test aborts everything** — no bump,
  no commit, no tag. This is the gate; do not skip it with `--force`.
- npm bumps `package.json` **and both version fields in `package-lock.json`**.
  Hand-editing `package.json` leaves the lockfile stale and surfaces later as a
  confusing diff.
- npm commits and tags (`v0.1.2`).
- `postversion` runs `npm run package`, leaving the `.vsix` ready.

Add `--no-git-tag-version` to bump without the commit and tag — useful when the
version change belongs in the same commit as something else. The hooks still run.

If the tests fail mentioning `sales.parquet` or `wide.parquet`, the fixtures are
missing rather than the code being broken:

```bash
npm run fixtures     # needs polars; writes the gitignored test/fixtures/data
```

The perf guards skip with a message when their fixtures are absent; the reader
tests fail outright, which is what you will see first.

## 4. What packaging can get wrong

`postversion` already ran `npm run package` for you; this section is why that
command looks the way it does.

`--no-dependencies` matters. esbuild has already bundled everything into
`dist/extension.js`, so vsce must not walk `node_modules` — with it, the VSIX is
about 200 KB; without it, tens of megabytes of files that are never loaded.

Two things that break packaging, both with unhelpful errors:

- **A relative link in `README.md` with no `repository` field.** vsce rewrites
  relative markdown links to absolute GitHub URLs and errors out if it cannot.
  The `repository` field in `package.json` is what it reads.
- **Images must use markdown syntax**, `![alt](assets/demo.gif)`. vsce does not
  rewrite `<img src>`, so an HTML tag produces a broken image on the listing.

Check the file list vsce prints. A healthy package is **8 files, about 200 KB**:

```
package.json  README.md  LICENSE  CHANGELOG.md
dist/extension.js
assets/tree-sitter.wasm  assets/tree-sitter-python.wasm  assets/icon.png
```

`.vscodeignore` is a **denylist**: anything new in the repo ships unless it is
named there. That is how a 249 MB `.venv` once reached a package — packaging
succeeded, nothing warned, and the file was 73 MB compressed. `npm run package`
now fails above 5 MB via `scripts/check-vsix.mjs`. If it does fail:

```bash
npx @vscode/vsce ls --no-dependencies    # exactly what would ship
```

## 5. Smoke-test the actual artifact

```bash
code --install-extension polarsense-0.1.1.vsix
```

Then open `test/fixtures/demo.py` and type inside a string. This is the same file
the Marketplace would serve, so anything wrong with it shows up here first —
which is exactly how a bundling bug was caught once already.

## 6. Publish

Upload the `.vsix` at
[marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
→ your publisher → the extension → **Update**.

Or from the command line, once `vsce login <publisher>` has been done with a
Personal Access Token scoped to **Marketplace → Manage** and issued for **all
accessible organizations**:

```bash
npx @vscode/vsce publish --no-dependencies
```

`vsce publish patch` also does the version bump, commit and tag in one step —
useful once the process is routine, but it hides step 3 and 4.

The `publisher` field must match a publisher ID you own exactly, including case.
A mismatch is rejected at upload with a message about permissions rather than
about the name.

### Open VSX

Cursor and Windsurf cannot install from Microsoft's Marketplace:

```bash
npx ovsx publish polarsense-0.1.1.vsix -p <open-vsx-token>
```

## 7. Push

`npm version` already made the commit and the tag, so:

```bash
git push --follow-tags
```

Push before the listing goes live: the README's image and links are served from
GitHub at render time, so an unpushed GIF is a broken image on the Marketplace
page.

## Checklist

```
[ ] CHANGELOG.md written and committed, number matches what changed
[ ] npm version patch|minor|major   (tests, bump, commit, tag, package)
[ ] the .vsix file list contains no src/ test/ docs/
[ ] installed the .vsix locally and typed into a string
[ ] git push --follow-tags   — including assets/demo.gif
[ ] uploaded, and Open VSX if you publish there
```
