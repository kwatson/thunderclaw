import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseSandboxProbe } from '../scripts/verify-release-sandbox-probe.mjs';
const identity = {repository:'kwatson/thunderclaw',commit:'a'.repeat(40),branch:'chore/sandbox',scenario:'environment-denial'};
const run = {id:1,run_attempt:1,repository:{full_name:identity.repository},event:'workflow_dispatch',path:'.github/workflows/validate-release-automation.yml',head_sha:identity.commit,head_branch:identity.branch,status:'completed',conclusion:'failure'};
const rejected = {name:'Read-only environment rejection probe',status:'completed',conclusion:'failure',steps:[]};
test('environment denial requires a rejected job with no executed steps',()=>{
 assert.equal(verifyReleaseSandboxProbe({...identity,run,jobs:[rejected]}).verified,true);
 assert.throws(()=>verifyReleaseSandboxProbe({...identity,run,jobs:[{...rejected,steps:[{name:'Unexpected admission'}]}]}));
});
test('probe evidence rejects unrelated runs, main branch, duplicate jobs and nonterminal runs',()=>{
 for (const change of [{head_sha:'b'.repeat(40)},{event:'push'},{head_branch:'main'},{status:'in_progress'},{path:'.github/workflows/release-openclaw-plugin.yml'}]) assert.throws(()=>verifyReleaseSandboxProbe({...identity,run:{...run,...change},jobs:[rejected]}));
 assert.throws(()=>verifyReleaseSandboxProbe({...identity,branch:'main',run,jobs:[rejected]}));
 assert.throws(()=>verifyReleaseSandboxProbe({...identity,run,jobs:[rejected,rejected]}));
});
test('cancellation proves the intended runner step started before cancellation',()=>{
 const cancelledRun={...run,conclusion:'cancelled'};
 const job={name:'Read-only cancellation probe',status:'completed',conclusion:'cancelled',steps:[{name:'Wait for operator cancellation',started_at:'2026-10-11T01:00:00Z'}]};
 assert.equal(verifyReleaseSandboxProbe({...identity,scenario:'cancellation',run:cancelledRun,jobs:[job]}).verified,true);
 assert.throws(()=>verifyReleaseSandboxProbe({...identity,scenario:'cancellation',run:cancelledRun,jobs:[{...job,steps:[]}]}));
});
