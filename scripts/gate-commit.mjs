#!/usr/bin/env node
/**
 * Gated commit (fork fix, 0.6.47).
 *
 * A commit must never land while the tree is red. The failure this replaces:
 * gate steps chained with `;` in a shell one-liner, so a failing typecheck
 * did not stop the chain and a commit landed with a RED suite — noticed only
 * by reading the tail of the output afterwards.
 *
 * The commit MESSAGE cannot travel through a package-script argument either:
 * npm/pnpm run scripts through `cmd.exe` on Windows, which splits a
 * multi-line argument at the newline — the body of the message was silently
 * dropped (a multi-paragraph rationale landed as its first line). So the
 * message comes from a FILE (or stdin), and git receives it with `-F`:
 *
 *   node scripts/gate-commit.mjs --file message.txt
 *   node scripts/gate-commit.mjs "a one-line message"
 *   echo "…" | node scripts/gate-commit.mjs
 *
 * The message is required — every commit in this repo carries a rationale
 * that doubles as documentation.
 *
 * The gate steps run as SEPARATE commands, each aborting the whole run:
 * typecheck → test → build → add → commit.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the commit message from --file, an argument, or stdin. */
function readMessage(argv) {
  const args = argv.slice(2)
  if (args[0] === '--') args.shift()
  if (args[0] === '--file') {
    if (args[1] === undefined) {
      console.error('gate-commit: --file needs a path')
      process.exit(2)
    }
    return readFileSync(args[1], 'utf8').trim()
  }
  if (args.length > 0) return args.join(' ').trim()
  try {
    return readFileSync(0, 'utf8').trim()
  } catch {
    return ''
  }
}

const message = readMessage(process.argv)
if (message.length === 0) {
  console.error('gate-commit: a commit message is required (it documents the change)')
  process.exit(2)
}

/**
 * Run one step, aborting the whole gate when it fails.
 *
 * pnpm is a .cmd shim on Windows, so it needs cmd.exe; it is invoked
 * explicitly (instead of `shell: true`) to keep the arguments unescaped-by-
 * surprise and the output free of Node's shell deprecation warning. git runs
 * WITHOUT a shell — with a shell, Node joins the command and its args with
 * spaces and no quoting, so a multi-word message would be truncated.
 */
function run(command, args) {
  const useCmd = process.platform === 'win32' && command === 'pnpm'
  const spawnArgs = useCmd
    ? ['/d', '/s', '/c', `${command} ${args.join(' ')}`]
    : args
  const result = spawnSync(useCmd ? (process.env.ComSpec ?? 'cmd.exe') : command, spawnArgs, {
    cwd: repo,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`gate-commit: ${command} ${args.join(' ')} failed — nothing was committed`)
    process.exit(result.status ?? 1)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-advisor-commit-'))
const messageFile = join(scratch, 'message.txt')
try {
  writeFileSync(messageFile, `${message}\n`, 'utf8')
  run('pnpm', ['typecheck'])
  run('pnpm', ['test'])
  run('pnpm', ['build'])
  run('git', ['add', '-A'])
  run('git', ['commit', '-F', messageFile])
  console.log('gate-commit: committed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
