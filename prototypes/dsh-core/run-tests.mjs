// Keep Vitest transform caches and fixtures inside the managed runtime directory.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const temporary = fileURLToPath(new URL('../../state/test-tmp/dsh-core/', import.meta.url))
const report = fileURLToPath(new URL('../../state/dsh-core/', import.meta.url))
mkdirSync(temporary, { recursive: true })
mkdirSync(report, { recursive: true })
const args = [fileURLToPath(new URL('node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--config', 'vitest.config.ts']
if (process.argv.includes('--json')) args.push('--reporter=json', '--outputFile=' + report + '/framework-tests.json')
const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
