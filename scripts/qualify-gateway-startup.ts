import { qualificationCommandProbe, waitForQualificationReadiness } from './qualification-readiness.js';
import { writeQualificationDiagnostic } from './qualification-diagnostics.mjs';

const container = process.env.THUNDERCLAW_QUALIFICATION_CONTAINER;
if (!container) throw new Error('Gateway startup requires an isolated qualification container');
await waitForQualificationReadiness((signal) => qualificationCommandProbe('docker', [
  'exec', container, 'node', 'openclaw.mjs', 'gateway', 'call', 'health', '--json',
], signal), { observe: (event) => writeQualificationDiagnostic({ phase: 'gateway-start', ...event }) });
