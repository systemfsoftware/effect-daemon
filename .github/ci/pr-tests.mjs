import { execFile, spawn } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const command = async (cmd, args, env = {}) => {
  const { stdout } = await exec(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const git = async (...args) => (await command('git', args)).trim()

const turboLs = async (env, affected) => {
  const text = await command('corepack', [
    'pnpm',
    'exec',
    'turbo',
    'ls',
    ...(affected ? ['--affected'] : []),
    '--output=json',
  ], env)
  return JSON.parse(text.slice(text.indexOf('{'))).packages.items
}

const manifest = async (pkg) => JSON.parse(await readFile(`${pkg.path}/package.json`, 'utf8'))

const owner = (packages, file) =>
  packages
    .filter((pkg) => file.startsWith(`${pkg.path}/`))
    .reduce((best, pkg) => (best === undefined || pkg.path.length > best.path.length ? pkg : best), undefined)

const otherTestTasks = ['test:engine']

const plan = async (base) => {
  const head = await git('rev-parse', 'HEAD')
  const scm = { TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head }
  const changed = (await git('diff', '--name-only', '--diff-filter=AMR', '-z', base, head)).split('\0').filter(Boolean)
  const [all, affected] = await Promise.all([turboLs(scm, false), turboLs(scm, true)])
  const manifests = new Map(await Promise.all(all.map(async (pkg) => [pkg.name, await manifest(pkg)])))

  const filesByPackage = new Map()
  for (const file of changed) {
    const pkg = owner(all, file)
    if (pkg === undefined) continue
    filesByPackage.set(pkg.name, [...(filesByPackage.get(pkg.name) ?? []), file.slice(pkg.path.length + 1)])
  }

  const commands = [[
    'corepack',
    'pnpm',
    'exec',
    'turbo',
    'run',
    'test',
    '--affected',
    '--continue',
    '--concurrency=50%',
    '--output-logs=new-only',
    '--log-order=stream',
    '--',
    `--changed=${base}`,
    '--passWithNoTests',
  ]]
  for (const [name, files] of filesByPackage) {
    for (const task of otherTestTasks) {
      if (manifests.get(name)?.scripts?.[task] === undefined) continue
      commands.push([
        'corepack',
        'pnpm',
        'exec',
        'turbo',
        'run',
        task,
        `--filter=${name}`,
        '--output-logs=new-only',
        '--',
        '--passWithNoTests',
        ...files,
      ])
    }
  }

  const browserPackages = affected.filter((pkg) => {
    const json = manifests.get(pkg.name)
    return json?.scripts?.test !== undefined && json.devDependencies?.playwright !== undefined
  })
  return { head, scm, changed, affected, commands, browserPackages }
}

const status = (cmd, args, env) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })

const mode = process.argv[2]
if (mode !== 'plan' && mode !== 'run') {
  console.error('usage: pr-tests.mjs plan|run')
  process.exit(2)
}
const base = process.env.BASE || (await git('rev-parse', 'HEAD^1'))
const { head, scm, changed, affected, commands, browserPackages } = await plan(base)

if (mode === 'plan') {
  console.log(`base ${base}, head ${head}: ${changed.length} changed files, ${affected.length} affected packages`)
  for (const pkg of affected) console.log(`  affected ${pkg.name}`)
  for (const cmd of commands) console.log(cmd.join(' '))
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    const browserPackage = browserPackages[0]?.name ?? ''
    await appendFile(
      output,
      `base=${base}\nbrowsers=${browserPackages.length > 0}\nbrowser-package=${browserPackage}\n`,
    )
  }
} else {
  let failed = false
  for (const [cmd, ...args] of commands) {
    console.log(`::group::${[cmd, ...args].join(' ')}`)
    const code = await status(cmd, args, scm)
    console.log('::endgroup::')
    if (code !== 0) {
      console.log(`::error title=pr-tests::${[cmd, ...args].join(' ')} exited ${code}`)
      failed = true
    }
  }
  process.exit(failed ? 1 : 0)
}
