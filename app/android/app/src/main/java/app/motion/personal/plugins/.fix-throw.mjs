import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const from = `        final int stagedBytes = spool().stagedLengthInt(token);
        final String stagedSha;
        try {
            stagedSha = spool().sha256Of(token);
        } catch (Exception e) {`;
const to = `        final int stagedBytes;
        final String stagedSha;
        try {
            stagedBytes = spool().stagedLengthInt(token);
            stagedSha = spool().sha256Of(token);
        } catch (Exception e) {`;
if (!s.includes(from)) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
s = s.replace(from, to);
writeFileSync(p, s, 'utf8');
console.log('OK: stagedBytes moved into try');
