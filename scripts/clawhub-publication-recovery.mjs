import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Retained submission evidence authorizes only another read, never another upload.
export function assessClawHubPublisher({ run, submission, repository, tag, commit }) {
  if (run?.repository?.full_name !== repository || run?.event !== 'workflow_dispatch'
      || run?.path?.split('@')[0] !== '.github/workflows/publish-clawhub.yml'
      || run?.head_sha !== commit || run?.head_branch !== tag
      || !Number.isSafeInteger(run?.id) || run.id < 1) {
    throw new Error('ClawHub publisher run does not match the exact protected-tag publication');
  }
  if (run.status !== 'completed') return 'await';
  if (run.conclusion === 'success') return 'complete';
  if (run.conclusion === 'cancelled') throw new Error('ClawHub publisher was cancelled; explicit operator recovery is required');
  if (submission?.publicationStatus === 'client-rejected') {
    throw new Error('ClawHub rejected submission; explicit operator recovery is required');
  }
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
    const [runFile, submissionFile, repository, tag, commit] = process.argv.slice(2);
    if (!runFile || !submissionFile || !repository || !tag || !commit) throw new Error('Expected run file, submission file, repository, tag, commit');
    let submission;
    try { submission = JSON.parse(await readFile(submissionFile, 'utf8')); }
    catch { /* Missing, expired, or malformed evidence cannot authorize another upload. */ }
    console.log(assessClawHubPublisher({ run: JSON.parse(await readFile(runFile, 'utf8')), submission, repository, tag, commit }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
