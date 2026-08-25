// Runs from npm's `version` lifecycle hook: after package.json is bumped,
// before npm commits. So the new number is in the environment, and staging the
// rewritten changelog folds it into npm's own version commit.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
const text = readFileSync('CHANGELOG.md', 'utf8');

if (!/^## Unreleased$/m.test(text)) {
  console.error(`CHANGELOG.md has no "## Unreleased" section — nothing to release as ${version}.`);
  process.exit(1);
}

writeFileSync('CHANGELOG.md', text.replace(/^## Unreleased$/m, `## ${version}`));
