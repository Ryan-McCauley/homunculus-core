#!/usr/bin/env node
// Runs the Python engine test suite with whichever interpreter this machine
// actually has.
//
// `python3 -m unittest` (the previous package.json script) is broken on Windows:
// the bare name resolves to the Microsoft Store *app execution alias*, a stub that
// installs nothing, prints "Python was not found…" and exits 9009. That is the exact
// trap server/screenerRunner.ts already documents and probes around — but `npm test`
// did not, so on the project's own Windows dev machine vitest would pass and the
// engine suite would die immediately, letting engine regressions ship untested.
//
// Probe order matches screenerRunner.ts so the tests run under the same interpreter
// the server will actually spawn: SCREENER_PYTHON wins if set, then the Windows `py`
// launcher, then the plain names.

import { spawnSync } from 'node:child_process'

function candidates() {
  const explicit = process.env['SCREENER_PYTHON']
  if (explicit) return [{ bin: explicit, args: [] }]
  return process.platform === 'win32'
    ? [{ bin: 'py', args: ['-3'] }, { bin: 'python', args: [] }, { bin: 'python3', args: [] }]
    : [{ bin: 'python3', args: [] }, { bin: 'python', args: [] }]
}

/** A real interpreter exits 0 and prints its own path; the Store stub does not. */
function works(cmd) {
  const probe = spawnSync(
    cmd.bin,
    [...cmd.args, '-c', 'import sys; sys.stdout.write(sys.executable or "python")'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  )
  return probe.status === 0 && (probe.stdout || '').trim().length > 0
}

const found = candidates().find(works)
if (!found) {
  console.error(
    '[engine tests] no working Python interpreter found.\n' +
    '  Tried: ' + candidates().map((c) => [c.bin, ...c.args].join(' ')).join(', ') + '\n' +
    '  Install Python 3, or set SCREENER_PYTHON to its full path.'
  )
  process.exit(1)
}

const run = spawnSync(
  found.bin,
  [...found.args, '-m', 'unittest', 'discover', '-t', '.', '-s', 'engine'],
  { stdio: 'inherit', windowsHide: true },
)
process.exit(run.status ?? 1)
