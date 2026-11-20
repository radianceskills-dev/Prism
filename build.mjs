import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
export const APP_ASSETS = Object.freeze([
  'index.html', 'styles.css', 'app.js', 'api.js', 'notion.js', 'mcp-client.js', 'composio.js', 'storage.js', 'attachments.js', 'kilo.js', 'parallel.mjs', 'favicon.svg',
  'markdown.js', 'vendor-marked.js', 'vendor-dompurify.js', 'artefacts.js', 'artefact-frame.html', 'catbox.js',
  'LICENSE-marked.txt', 'LICENSE-dompurify.txt', 'LICENSE-dompurify-MPL.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
]);
export const BUILD_FILES = Object.freeze([...APP_ASSETS, '_headers']);

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// No recursive deletion: refuse unexpected files and links before touching output.
// The optional target is useful for packaging checks in an isolated temp directory.
export async function build(target = join(sourceDirectory, 'dist')) {
  const destination = resolve(target instanceof URL ? fileURLToPath(target) : target);
  const sourceFromTarget = relative(destination, sourceDirectory);
  if (!sourceFromTarget || (!isAbsolute(sourceFromTarget) && sourceFromTarget !== '..' && !sourceFromTarget.startsWith(`..${sep}`))) {
    throw new Error('Build target must not be the source directory or one of its ancestors.');
  }
  for (let path = destination; ; path = dirname(path)) {
    const stat = await statIfPresent(path);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`Build target path must contain only ordinary directories: ${path}`);
    }
    if (dirname(path) === path) break;
  }
  if (await statIfPresent(destination)) {
    for (const name of await readdir(destination)) {
      if (!BUILD_FILES.includes(name)) throw new Error(`Refusing to modify build target with unexpected entry: ${name}`);
      const stat = await lstat(join(destination, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
        throw new Error(`Refusing to overwrite non-regular or linked output: ${name}`);
      }
    }
  }
  // Read the complete fixed allowlist before writing; never copy the source tree,
  // environment files, tests, dependencies, or preview/build scripts.
  const contents = await Promise.all(BUILD_FILES.map(async name => {
    const path = join(sourceDirectory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Build asset must be a regular file: ${name}`);
    return readFile(path);
  }));
  await mkdir(destination, { recursive: true });
  for (const [index, name] of BUILD_FILES.entries()) {
    await writeFile(join(destination, name), contents[index]);
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const destination = await build();
    console.log(`Built ${APP_ASSETS.length} app assets plus _headers in ${destination}`);
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
