# Releasing

The whole process is six commands. The notes exist because three of the steps
have a way to go wrong that is not obvious from the error message.

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

## 3. Bump the version

```bash
npm version patch --no-git-tag-version     # or minor / major / an exact 0.1.1
```

This updates `package.json` **and both version fields in `package-lock.json`** —
hand-editing `package.json` leaves the lockfile stale, which shows up later as a
confusing diff. `--no-git-tag-version` keeps git out of it so you can commit the
bump together with the changelog.

Without that flag, `npm version` creates its own commit and tag, and refuses to
run on a dirty tree.

## 4. Test and build

```bash
npm run fixtures     # only when test/fixtures/data is empty — needs polars
npm test             # builds, then runs the suite
```

`npm run fixtures` generates the test data, which is gitignored because some of
it is large. Without it the perf guards skip (with a message saying so) and the
reader tests fail — if you see failures mentioning `sales.parquet` or
`wide.parquet`, that is the step you missed.

## 5. Package

```bash
npm run package      # npm run build && vsce package --no-dependencies
```

`--no-dependencies` matters. esbuild has already bundled everything into
`dist/extension.js`, so vsce must not walk `node_modules` — with it, the VSIX is
about 200 KB; without it, tens of megabytes of files that are never loaded.

Two things that break packaging, both with unhelpful errors:

- **A relative link in `README.md` with no `repository` field.** vsce rewrites
  relative markdown links to absolute GitHub URLs and errors out if it cannot.
  The `repository` field in `package.json` is what it reads.
- **Images must use markdown syntax**, `![alt](assets/demo.gif)`. vsce does not
  rewrite `<img src>`, so an HTML tag produces a broken image on the listing.

Check the file list vsce prints. `src/`, `test/`, `docs/` and `scripts/` should
not be in it — `.vscodeignore` controls that.

## 6. Smoke-test the actual artifact

```bash
code --install-extension polarsense-0.1.1.vsix
```

Then open `test/fixtures/demo.py` and type inside a string. This is the same file
the Marketplace would serve, so anything wrong with it shows up here first —
which is exactly how a bundling bug was caught once already.

## 7. Publish

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

## 8. Tag and push

```bash
git commit -am "release 0.1.1"
git tag v0.1.1
git push && git push --tags
```

Push before the listing goes live: the README's image and links are served from
GitHub at render time, so an unpushed GIF is a broken image on the Marketplace
page.

## Checklist

```
[ ] CHANGELOG.md written, version number matches what changed
[ ] npm version …  (package.json + package-lock.json)
[ ] npm test — green
[ ] npm run package — file list contains no src/test/docs
[ ] installed the .vsix locally and typed into a string
[ ] pushed to GitHub, including assets/demo.gif
[ ] uploaded, and Open VSX if you publish there
[ ] tagged v<version>
```
