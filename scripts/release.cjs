'use strict';
// Publishes a JVoice release to GitHub. Installed copies pick it up on their next update check.
//   1. Bump "version" in package.json and commit.
//   2. Write the user-facing changelog to release-notes/v<version>.md.
//   3. npm run release
// The installer is signed with the Ed25519 key in ~/.jvoice/release-signing-key.pem (never in the repo).
// Installed copies refuse any update without a matching .sig, so keep that file backed up.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signedMessage, verifySignature, sha512File } = require('../app/updater.cjs');

const root = path.join(__dirname, '..');
const REPO = 'Josephivgi/JVoice';
const KEY_FILE = process.env.JVOICE_SIGNING_KEY || path.join(os.homedir(), '.jvoice', 'release-signing-key.pem');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const { version, build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const notes = path.join(root, 'release-notes', `${tag}.md`);
const installer = build.nsis.artifactName.replace('${version}', version).replace('${ext}', 'exe');
const dist = path.join(root, 'dist');

function fail(msg) { console.error(`release: ${msg}`); process.exit(1); }

(async () => {
  if (out('git', ['status', '--porcelain'])) fail('commit or stash your changes first.');
  if (!fs.existsSync(notes)) fail(`write the changelog in release-notes/${tag}.md first.`);
  if (!fs.existsSync(KEY_FILE)) fail(`signing key not found at ${KEY_FILE}.`);
  let published = false;
  try { out('gh', ['release', 'view', tag, '--repo', REPO]); published = true; } catch { /* not published yet */ }
  if (published) fail(`${tag} is already published. Bump the version.`);

  run('npm', ['test'], { shell: true });
  fs.rmSync(dist, { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', '--publish', 'never'], { shell: true });

  const files = [installer, `${installer}.blockmap`, 'latest.yml'].map((f) => path.join(dist, f));
  for (const f of files) if (!fs.existsSync(f)) fail(`build did not produce ${path.basename(f)}.`);

  const sha512 = await sha512File(files[0]);
  if (!fs.readFileSync(files[2], 'utf8').includes(sha512)) fail('latest.yml does not match the installer.');
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const signature = crypto.sign(null, signedMessage({ version, file: installer, sha512 }), key).toString('base64');
  if (!verifySignature({ version, file: installer, sha512, signature })) fail('the signing key does not match the key built into the app.');
  const sig = path.join(dist, `${installer}.sig`);
  fs.writeFileSync(sig, `${signature}\n`);

  if (!out('git', ['tag', '--list', tag])) run('git', ['tag', tag]);
  run('git', ['push', 'origin', 'HEAD', tag]);
  run('gh', ['release', 'create', tag, '--repo', REPO, '--title', `JVoice ${version}`, '--notes-file', notes, '--verify-tag', ...files, sig]);
  console.log(`release: ${tag} published. Installed copies update within a few hours, or at their next start.`);
})().catch((err) => fail(err.message));
