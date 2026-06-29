import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ValidationReport } from './validator'

const ROOT = process.cwd()

function gitIgnoreGuard(): { ok: boolean; reason?: string } {
  const path = join(ROOT, '.gitignore')
  if (!existsSync(path)) return { ok: false, reason: '.gitignore not found' }
  const content = readFileSync(path, 'utf-8')
  if (!content.includes('.env')) return { ok: false, reason: '.gitignore does not contain .env pattern — secrets may leak' }
  return { ok: true }
}

function run(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim()
}

export function autoPushIfPass(validation: ValidationReport, commitMsg: string): void {
  // Guard: only in local dev
  if (process.env.VERCEL) {
    console.log('[auto-push] skip — running on Vercel')
    return
  }

  // Guard: validation must pass
  if (!validation.pass) {
    console.log('[auto-push] skip — validation FAIL:', validation.summary)
    return
  }

  // Guard: .gitignore must protect secrets
  const guard = gitIgnoreGuard()
  if (!guard.ok) {
    console.error('[auto-push] BLOCKED —', guard.reason)
    return
  }

  // Guard: must have something to commit
  const status = run('git status --porcelain')
  if (!status) {
    console.log('[auto-push] nothing to commit')
    return
  }

  try {
    const branch = run('git branch --show-current') || 'main'
    run('git add -A')
    run(`git commit -m ${JSON.stringify(commitMsg)}`)
    run(`git push origin ${branch}`)
    console.log(`[auto-push] pushed to ${branch}: ${commitMsg}`)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[auto-push] error:', msg.split('\n')[0])
  }
}
