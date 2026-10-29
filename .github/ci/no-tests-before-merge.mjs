import { appendFile } from 'node:fs/promises'

const output = process.env.GITHUB_OUTPUT
if (process.argv[2] === 'plan' && output) await appendFile(output, 'jobs=[]\n')
