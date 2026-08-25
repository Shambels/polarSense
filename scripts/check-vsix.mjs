/**
 * Fails the build if the packaged extension is bigger than it has any right to be.
 *
 * `.vscodeignore` is a denylist: anything new in the repo ships unless it is
 * excluded. That is how a 249 MB Python virtualenv once ended up inside a VSIX —
 * silently, because packaging still succeeded. This turns "silently" into a
 * failed command.
 */
import { readdirSync, statSync } from 'node:fs';

const LIMIT_MB = Number(process.env.VSIX_LIMIT_MB ?? 5);

const packages = readdirSync('.')
  .filter((name) => name.endsWith('.vsix'))
  .map((name) => ({ name, size: statSync(name).size }))
  .sort((a, b) => b.size - a.size);

if (!packages.length) {
  console.error('check-vsix: no .vsix found — did packaging run?');
  process.exit(1);
}

const [newest] = readdirSync('.')
  .filter((name) => name.endsWith('.vsix'))
  .map((name) => ({ name, mtime: statSync(name).mtimeMs, size: statSync(name).size }))
  .sort((a, b) => b.mtime - a.mtime);

const mb = newest.size / 1024 / 1024;
if (mb > LIMIT_MB) {
  console.error(
    `\ncheck-vsix: ${newest.name} is ${mb.toFixed(1)} MB, over the ${LIMIT_MB} MB limit.` +
    `\n\nSomething is being packaged that should not be. To see what:` +
    `\n  npx @vscode/vsce ls --no-dependencies` +
    `\n\nThen add it to .vscodeignore. Raise the limit with VSIX_LIMIT_MB=<n> only if` +
    `\nthe extension genuinely got bigger.\n`
  );
  process.exit(1);
}

console.log(`check-vsix: ${newest.name} is ${mb.toFixed(2)} MB (limit ${LIMIT_MB} MB) ✓`);
if (packages.length > 1) {
  console.log(`check-vsix: note — ${packages.length} .vsix files present; older ones are ignored by packaging.`);
}
