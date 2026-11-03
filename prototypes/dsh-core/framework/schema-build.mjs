import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { Schemas } from './contracts.mjs'
const dir = new URL('./schemas/', import.meta.url)
mkdirSync(dir, { recursive: true })
for (const [name, schema] of Object.entries(Schemas)) writeFileSync(new URL(name + '.json', dir), JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n')
