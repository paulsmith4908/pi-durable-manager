// Reproducible UI-only extraction. Never imports the upstream agent entry point.
// See docs/ACTUAL-PI-TERMINAL.md for the pinned inputs and dependency preparation.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [upstreamArg, toolsArg, archiveArg] = process.argv.slice(2);
if (!upstreamArg || !toolsArg || !archiveArg) throw Error('Usage: build-pi-ui-vendor.mjs EXTRACTED_PACKAGE BUILD_TOOLS_DIR ARCHIVE_TGZ');
const upstream = resolve(upstreamArg), tools = resolve(toolsArg), archive = resolve(archiveArg);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), dest = join(root, 'vendor/pi-ui');
const pkg = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '1.4.0') throw Error('Only the reviewed pinned Pi UI 1.4.0 is supported.');
const { build } = await import(pathToFileURL(join(tools, 'node_modules/esbuild/lib/main.js')).href);
mkdirSync(dest, { recursive: true });
const entry = join(tools, 'pi-ui-entry.mjs');
writeFileSync(entry, [
  ['UserMessageComponent', 'components/user-message.js'],
  ['AssistantMessageComponent', 'components/assistant-message.js'],
  ['ToolExecutionComponent', 'components/tool-execution.js'],
  ['getMarkdownTheme, theme, loadThemeFromPath, setThemeInstance', 'theme/theme.js'],
].map(([names, file]) => `export { ${names} } from ${JSON.stringify(join(upstream, 'dist/modes/interactive', file))};`).join('\n'));
for (const [names, file] of [['createShellRenderers', 'bash'], ['readRenderers', 'read'], ['writeRenderers', 'write']]) writeFileSync(entry, readFileSync(entry, 'utf8') + `\nexport { ${names} } from ${JSON.stringify(join(upstream, 'dist/core/tools/renderers', file + '.js'))};\n`);
const config = 'export const getCustomThemesDir=()=>{throw Error("Observer custom theme discovery is disabled")}; export const getThemesDir=()=>{throw Error("Observer uses an explicit packaged theme")}; export const getBinDir=()=>{throw Error("Observer cannot execute tools")}; export const getReadmePath=()=>"/__pi_observer_no_resources__/README.md";';
const processes = 'export const spawnProcess=()=>{throw Error("Observer cannot spawn processes")}; export const spawnProcessSync=spawnProcess; export const waitForChildProcess=spawnProcess;';
const result = await build({ absWorkingDir: tools, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: join(dest, 'components.mjs'), external: ['@earendil-works/pi-tui'], metafile: true, legalComments: 'eof', plugins: [{ name: 'observer-only-boundaries', setup(b) {
  for (const [filter, name] of [[/config\.js$/, 'ui-config'], [/child-process\.js$/, 'processes-disabled'], [/image-convert\.js$/, 'images-disabled']]) b.onResolve({ filter }, a => a.importer.startsWith(upstream + '/') ? { path: name, namespace: 'boundary' } : null);
  b.onLoad({ filter: /.*/, namespace: 'boundary' }, a => ({ contents: a.path === 'ui-config' ? config : a.path === 'processes-disabled' ? processes : 'export function ensurePngTranscoder(){}', loader: 'js' }));
} }] });
const inputs = Object.keys(result.metafile.inputs).sort();
if (inputs.some(p => /auth-storage|agent-session|\/pi-mcp\/|providers\//.test(p))) throw Error('Agent/credential module in UI bundle; do not use this output.');
copyFileSync(join(upstream, 'dist/modes/interactive/theme/dark.json'), join(dest, 'dark.json'));
copyFileSync(join(upstream, 'LICENSE'), join(dest, 'LICENSE'));
copyFileSync(join(tools, 'node_modules/chalk/license'), join(dest, 'LICENSE.chalk'));
copyFileSync(join(tools, 'node_modules/highlight.js/LICENSE'), join(dest, 'LICENSE.highlight.js'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(join(dest, 'provenance.json'), JSON.stringify({ package: pkg.name, version: pkg.version, archive: 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.4.0.tgz', archiveSha256: hash(archive), componentsSha256: hash(join(dest, 'components.mjs')), themeSha256: hash(join(dest, 'dark.json')), boundaries: ['No agent/session/auth/provider/MCP modules', 'Explicit packaged theme only; no user config discovery', 'Process execution and image transcoding disabled'], inputs }, null, 2) + '\n');
console.log(JSON.stringify({ version: pkg.version, bytes: readFileSync(join(dest, 'components.mjs')).length, inputs: inputs.length }));
