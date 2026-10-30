import { createHash } from 'node:crypto';

/** Preserve the tested production graph; npm ci must not resolve new versions. */
export function runtimeLock(sourceLock, managerPackage, payloadName, payloadBytes) {
  if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages?.[''] || sourceLock.packages[''].version !== managerPackage.version) throw Error('Source dependency lock is missing or stale.');
  if (JSON.stringify(sourceLock.packages[''].dependencies) !== JSON.stringify(managerPackage.dependencies)) throw Error('Source dependency lock does not match package dependencies.');
  const pkg = { name: 'pi-durable-private-runtime', version: managerPackage.version, private: true, dependencies: { 'pi-durable-manager': `file:${payloadName}` } };
  const packages = { '': pkg };
  for (const [name, entry] of Object.entries(sourceLock.packages)) {
    if (!name || entry.dev === true) continue;
    if (!name.startsWith('node_modules/') || entry.link || !entry.integrity || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '')) throw Error('Production lock requires integrity-pinned npm registry packages.');
    packages[name] = entry;
  }
  packages['node_modules/pi-durable-manager'] = {
    version: managerPackage.version, resolved: `file:${payloadName}`,
    integrity: 'sha512-' + createHash('sha512').update(payloadBytes).digest('base64'),
    license: managerPackage.license, dependencies: managerPackage.dependencies,
    bin: Object.fromEntries(Object.entries(managerPackage.bin ?? {}).map(([key, value]) => [key, value.replace(/^\.\//, '')])),
    engines: managerPackage.engines,
  };
  return { pkg, lock: { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages } };
}
