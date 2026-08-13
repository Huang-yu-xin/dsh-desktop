// Asserts the exported product sanitizer redacts the exact secret forms the
// logs viewer must never show. Runs against the built dist output.
import { sanitizeLogs } from 'file:///D:/software/dsh-desktop/dist/main/logs.js';

const cases = [
  ['Authorization: Bearer SECRET123abc', /SECRET123abc/],
  ['authorization=bearer-TOKEN-987', /bearer-TOKEN-987/],
  ['Bearer abcdefgh12345', /abcdefgh12345/],
  ['DEEPSEEK_API_KEY=sk-value-111', /sk-value-111/],
  ['OPENAI_API_KEY: sk-abcdefgh12345678', /sk-abcdefgh12345678/],
  ['sk-abcdefgh12345678', /sk-abcdefgh12345678/],
  ['x-api-key = 9876543210', /9876543210/],
];

let failed = 0;
for (const [input, forbidden] of cases) {
  const out = sanitizeLogs(input);
  const leaked = forbidden.test(out);
  console.log(`[${leaked ? 'FAIL' : 'PASS'}] ${input} -> ${out}`);
  if (leaked) failed += 1;
}
// The redaction marker must be present when a secret was found.
const marked = sanitizeLogs('Authorization: Bearer SECRET123abc');
if (!marked.includes('REDACTED')) {
  console.log('[FAIL] redaction marker missing');
  failed += 1;
}
console.log(failed === 0 ? 'SANITIZE: ALL PASS' : `SANITIZE: ${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
