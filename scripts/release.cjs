'use strict';
// Publishes a JVoice release to GitHub. Installed copies pick it up on their next update check.
//   1. Bump "version" in package.json and commit.
//   2. Write the user-facing changelog to release-notes/v<version>.md.
//   3. npm run release
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const notes = path.join(root, 'release-notes', `${tag}.md`);

function fail(msg) { console.error(`release: ${msg}`); process.exit(1); }

if (out('git', ['status', '--porcelain'])) fail('commit or stash your changes first.');
if (!fs.existsSync(notes)) fail(`write the changelog in release-notes/${tag}.md first.`);
try { out('gh', ['release', 'view', tag, '--repo', 'Josephivgi/JVoice']); fail(`${tag} is already published. Bump the version.`); } catch { /* not published yet */ }

run('npm', ['test'], { shell: true });
if (!out('git', ['tag', '--list', tag])) run('git', ['tag', tag]);
run('git', ['push', 'origin', 'HEAD', '--follow-tags']);

// electron-builder uploads the installer, its blockmap and latest.yml (the file the updater reads).
const env = { ...process.env, GH_TOKEN: out('gh', ['auth', 'token']) };
run('npx', ['electron-builder', '--win', '--publish', 'always'], { env, shell: true });
run('gh', ['release', 'edit', tag, '--repo', 'Josephivgi/JVoice', '--title', `JVoice ${version}`, '--notes-file', notes]);
console.log(`release: ${tag} published. Installed copies update within a few hours, or at their next start.`);
