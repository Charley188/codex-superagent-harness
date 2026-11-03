// Codex's candidate DB is separate from both Python v1 and DSH deployment DBs.
// Upstream schema-10 migration imports DSH runtime services; it is deliberately not activated here.
export const OLDEST_SCHEMA = 11
export const SCHEMA_VERSION = 11
export const tooOld = version => `Unsupported imported schema ${version}; use a separate, reviewed migration`
export function migrateTo11() { throw new Error('DSH deployment migration is not enabled in the Codex adapter') }
