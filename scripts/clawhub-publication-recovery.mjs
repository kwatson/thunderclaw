import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Shared by the probe, dispatch waiter, and hourly controller. Never truncate history.
export function selectOriginalClawHubPublisher(runs, { repository, tag, commit }) {
  const matches = runs.filter((run) => run.head_branch === tag);
  if (matches.length > 1) throw new Error('Ambiguous original ClawHub publisher runs; operator review required');
  const run = matches[0];
  if (!run) return null;
  authenticatePublisherRun(run, { repository, tag, commit });
  return run;
}

export function findOriginalClawHubPublisher(identity, execute = execFileSync) {
  const response = execute('gh', ['api', '--paginate', '--slurp',
    `repos/${identity.repository}/actions/workflows/publish-clawhub.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(identity.tag)}&per_page=100`], { encoding: 'utf8' });
  const pages = JSON.parse(response);
  return selectOriginalClawHubPublisher(pages.flatMap((page) => page.workflow_runs), identity);
}

function authenticatePublisherRun(run, { repository, tag, commit }) {
  if (run?.repository?.full_name !== repository || run?.event !== 'workflow_dispatch'
      || run?.path?.split('@')[0] !== '.github/workflows/publish-clawhub.yml'
      || run?.head_sha !== commit || run?.head_branch !== tag
      || !Number.isSafeInteger(run?.id) || run.id < 1) {
    throw new Error('ClawHub publisher run does not match the exact protected-tag publication');
  }
}

// Retained submission evidence authorizes only another read, never another upload.
export function assessClawHubPublisher({ run, submission, repository, tag, commit }) {
  authenticatePublisherRun(run, { repository, tag, commit });
  if (run.status !== 'completed') return 'await';
  if (run.conclusion === 'cancelled') throw new Error('ClawHub publisher was cancelled; explicit operator recovery is required');
  if (['client-rejected', 'rejected', 'cancelled'].includes(submission?.publicationStatus)) {
    throw new Error('ClawHub rejected submission; explicit operator recovery is required');
  }
  if (run.conclusion === 'success') return 'complete';
  if (submission?.publicationStatus === 'client-unconfirmed') return 'verify-public';
  const version = tag.replace(/^openclaw-plugin-v/u, '');
  if (submission?.name !== '@thunderclaw/openclaw-plugin' || submission?.version !== version
      || typeof submission?.attemptId !== 'string' || !submission.attemptId
      || typeof submission?.releaseId !== 'string' || !submission.releaseId
      || !['pending', 'published'].includes(submission?.publicationStatus)) {
    throw new Error('Failed ClawHub publisher has no accepted submission evidence; explicit operator recovery is required');
  }
  return 'verify-public';
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === 'find') {
      const [, repository, tag, commit] = process.argv.slice(2);
      if (!repository || !tag || !commit) throw new Error('Expected repository, tag, commit');
      console.log(JSON.stringify(findOriginalClawHubPublisher({ repository, tag, commit })));
    } else {
    const [runFile, submissionFile, repository, tag, commit] = process.argv.slice(2);
    if (!runFile || !submissionFile || !repository || !tag || !commit) throw new Error('Expected run file, submission file, repository, tag, commit');
    let submission;
    try { submission = JSON.parse(await readFile(submissionFile, 'utf8')); }
    catch { /* Missing, expired, or malformed evidence cannot authorize another upload. */ }
    console.log(assessClawHubPublisher({ run: JSON.parse(await readFile(runFile, 'utf8')), submission, repository, tag, commit }));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
