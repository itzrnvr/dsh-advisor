#!/usr/bin/env node
/**
 * Gated commit (fork fix, 0.6.46).
 *
 * A commit must never land while the tree is red. The failure this replaces:
 * gate steps chained with `;` in a shell one-liner, so a failing typecheck
 * did not stop the chain and a commit landed with a RED suite — noticed only
 * by reading the tail of the output afterwards.
 *
 * This wrapper is cross-platform (npm/pnpm cannot pass a message through a
 * script string: extra CLI args are APPENDED to the whole line, and `%*`/`$@`
 * do not expand inside a package script). It runs the gate as SEPARATE
 * commands, aborting on the first failure, and commits only when every step
 * passed:
 *
 *   node scripts/gate-commit.mjs "the message"
 *
 * The message is required — a commit without one is rejected, because every
 * commit in this repo carries a rationale that doubles as documentation.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// `pnpm gate:commit -- "message"` is the invocation people naturally type, and
// npm/pnpm forward that `--` inconsistently across versions — drop it when it
// is there.
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const message = args.join(' ').trim()

if (message.length === 0) {
  console.error('gate-commit: a commit message is required (it documents the change)')
  process.exit(2)
}

/**
 * Run one step, aborting the whole gate when it fails.
 *
 * `shell: true` only for pnpm (its Windows shim is a .cmd file); git runs
 * WITHOUT a shell — with a shell, Node joins the command and its args with
 * spaces and no quoting, so a multi-word commit message would be truncated to
 * its first word and the rest would land as pathspecs.
 */
function run(command, args) {
  const useShell = process.platform === 'win32' && command === 'pnpm'
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', shell: useShell })
  if (result.status !== 0) {
    console.error(`gate-commit: ${command} ${args.join(' ')} failed — nothing was committed`)
    process.exit(result.status ?? 1)
  }
}

run('pnpm', ['typecheck'])
run('pnpm', ['test'])
run('pnpm', ['build'])
run('git', ['add', '-A'])
run('git', ['commit', '-m', message])
console.log('gate-commit: committed')
