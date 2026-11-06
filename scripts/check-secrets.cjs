// Deliberately reports locations, never matching credential values. This is a
// small supplemental check; enable GitHub secret scanning/push protection too.
const { execFileSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const patterns = {
    private_key: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    aws_access_key: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    github_token: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    stripe_secret: /\bsk_live_[A-Za-z0-9]{20,}\b/,
    openai_secret: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/,
};
let findings = 0;
for (const file of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
    if (
        /package-lock\.json$|\.(?:png|jpe?g|gif|woff2?|ttf|mp3|mp4|webp|zip)$/.test(file) ||
        statSync(file).size > 5 * 1024 * 1024
    )
        continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
        for (const [kind, pattern] of Object.entries(patterns))
            if (pattern.test(line)) {
                console.error(JSON.stringify({ file, line: index + 1, kind }));
                findings++;
            }
    });
}
console.log(`Credential-pattern scan: ${findings} finding(s). No matching values were printed.`);
process.exitCode = findings ? 1 : 0;
