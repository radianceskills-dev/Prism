import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_ASSETS, BUILD_FILES, build } from '../build.mjs';

const sourceDirectory = fileURLToPath(new URL('../', import.meta.url));
const expected = ['index.html', 'styles.css', 'app.js', 'api.js', 'notion.js', 'mcp-client.js', 'composio.js', 'storage.js', 'attachments.js', 'kilo.js', 'parallel.mjs', 'favicon.svg', 'markdown.js', 'vendor-marked.js', 'vendor-dompurify.js', 'artefacts.js', 'artefact-frame.html', 'catbox.js', 'LICENSE-marked.txt', 'LICENSE-dompurify.txt', 'LICENSE-dompurify-MPL.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '_headers'];

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'prism-build-test-'));
  t.after(async () => {
    // Only clean this test's verified, freshly-created temporary directory.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'prism-build-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function runNode(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0);
}

test('build copies the fixed app and licensed Markdown assets plus headers, never backend/secrets/tests', async t => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, 'site');
  assert.equal(APP_ASSETS.length, expected.length - 1);
  assert.deepEqual([...BUILD_FILES], expected);
  assert.equal(await build(target), target);
  assert.deepEqual((await readdir(target)).sort(), [...expected].sort());
  for (const name of expected) {
    assert.ok((await lstat(join(target, name))).isFile(), name);
    assert.deepEqual(await readFile(join(target, name)), await readFile(join(sourceDirectory, name)), name);
  }
  for (const name of ['server.mjs', 'build.mjs', 'package.json', 'package-lock.json', '.env', '.git', 'tests', 'node_modules', '_redirects']) {
    await assert.rejects(lstat(join(target, name)), { code: 'ENOENT' });
  }
});

test('build is repeatable and refreshes only its fixed output files', async t => {
  const directory = await temporaryDirectory(t);
  await build(directory);
  await writeFile(join(directory, 'app.js'), 'old app');
  await build(pathToFileURL(directory));
  assert.deepEqual(await readFile(join(directory, 'app.js')), await readFile(join(sourceDirectory, 'app.js')));
  assert.deepEqual((await readdir(directory)).sort(), [...expected].sort());
});

test('build refuses unexpected files and directories before changing any output', async t => {
  const directory = await temporaryDirectory(t);
  for (const entry of ['.env', 'personal-notes.txt', 'nested-directory']) {
    const target = join(directory, entry.replaceAll('.', '_'));
    await mkdir(target);
    await writeFile(join(target, 'app.js'), 'leave unchanged');
    if (entry === 'nested-directory') await mkdir(join(target, entry));
    else await writeFile(join(target, entry), 'do not delete');
    await assert.rejects(build(target), /unexpected entry/);
    assert.equal(await readFile(join(target, 'app.js'), 'utf8'), 'leave unchanged');
    assert.deepEqual((await readdir(target)).sort(), ['app.js', entry].sort());
    if (entry !== 'nested-directory') assert.equal(await readFile(join(target, entry), 'utf8'), 'do not delete');
  }
});

test('build refuses non-files, hard links and symlinked destination paths', async t => {
  const directory = await temporaryDirectory(t);
  const nonFileTarget = join(directory, 'non-file');
  await mkdir(join(nonFileTarget, 'app.js'), { recursive: true });
  await assert.rejects(build(nonFileTarget), /non-regular or linked output/);
  const fileTarget = join(directory, 'file');
  await writeFile(fileTarget, 'keep');
  await assert.rejects(build(fileTarget), /ordinary directories/);
  assert.equal(await readFile(fileTarget, 'utf8'), 'keep');

  const hardLinkTarget = join(directory, 'hardlink');
  await mkdir(hardLinkTarget);
  await link(fileTarget, join(hardLinkTarget, 'app.js'));
  await assert.rejects(build(hardLinkTarget), /non-regular or linked output/);
  assert.equal(await readFile(fileTarget, 'utf8'), 'keep');

  // Directory junctions require no Windows developer-mode/admin symlink privilege.
  const realTarget = join(directory, 'real');
  const linkedTarget = join(directory, 'linked');
  await mkdir(realTarget);
  await symlink(realTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(build(linkedTarget), /ordinary directories/);
  await assert.rejects(build(join(linkedTarget, 'child')), /ordinary directories/);
  assert.deepEqual(await readdir(realTarget), []);

  const linkedOutput = join(directory, 'linked-output');
  await mkdir(linkedOutput);
  await symlink(realTarget, join(linkedOutput, 'app.js'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(build(linkedOutput), /non-regular or linked output/);
  assert.deepEqual(await readdir(realTarget), []);
});

test('build refuses the source directory and its ancestors', async () => {
  await assert.rejects(build(sourceDirectory), /source directory/);
  await assert.rejects(build(dirname(sourceDirectory)), /source directory/);
});

test('import has no build side effects; CLI builds relative to its own location', async t => {
  const directory = await temporaryDirectory(t);
  const fixture = join(directory, 'project');
  await mkdir(fixture);
  const script = join(fixture, 'build.mjs');
  await copyFile(join(sourceDirectory, 'build.mjs'), script);
  await runNode(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)})`], directory);
  assert.deepEqual(await readdir(fixture), ['build.mjs']);
  for (const name of expected) await copyFile(join(sourceDirectory, name), join(fixture, name));
  await runNode([script], directory);
  assert.deepEqual((await readdir(join(fixture, 'dist'))).sort(), [...expected].sort());
  await assert.rejects(lstat(join(directory, 'dist')), { code: 'ENOENT' });
});

test('packaged HTML uses relative assets so it can be hosted under a subpath', async t => {
  const directory = await temporaryDirectory(t);
  await build(directory);
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(references.includes('./app.js'));
  assert.ok(references.includes('./styles.css'));
  assert.ok(references.includes('./favicon.svg'));
  for (const reference of references) {
    assert.ok(reference.startsWith('./') || reference.startsWith('#') || /^https?:/.test(reference), reference);
  }
  for (const name of ['app.js', 'api.js', 'attachments.js', 'notion.js', 'mcp-client.js', 'composio.js', 'parallel.mjs', 'markdown.js']) {
    const code = await readFile(join(directory, name), 'utf8');
    for (const match of code.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) {
      assert.ok(match[1].startsWith('./'), `${name}: ${match[1]}`);
      assert.ok(APP_ASSETS.includes(match[1].slice(2)), `${name}: ${match[1]}`);
    }
  }
});
