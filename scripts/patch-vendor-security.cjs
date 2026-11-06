// Backport the maintained Lodash baseSet pollution guard into the exact vendor
// files used by SmartCharts. A changed upstream file requires a reviewed update;
// do not silently skip this patch or remove its checksum checks.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const specifications = [
    {
        file: '@deriv/deriv-charts/dist/smartcharts.js',
        sha256: '034d4a4119d8d107b1d9187e94c76155fd171ea51ec2c56c1f4dadf844ed2efd',
        needle: 'var h=F(e[a]),u=r;if(a!=l)',
        replacement: 'var h=F(e[a]),u=r;if(h==="__proto__"||h==="constructor"||h==="prototype")return t;if(a!=l)',
    },
];
const digest = value => createHash('sha256').update(value).digest('hex');
function transform(source, specification) {
    const { needle, replacement, sha256 } = specification;
    if (source.split(replacement).length === 2) {
        // Only accept our exact patched file, including all surrounding code.
        if (digest(source.replace(replacement, needle)) === sha256) return source;
    }
    if (digest(source) !== sha256 || source.split(needle).length !== 2)
        throw new Error(`Review the security backport for ${specification.file}; upstream contents changed.`);
    return source.replace(needle, replacement);
}
function patch(root = path.resolve(__dirname, '../node_modules')) {
    // Verify every file before changing any file.
    const outputs = specifications.map(specification => {
        const file = path.join(root, specification.file);
        return [file, transform(fs.readFileSync(file, 'utf8'), specification)];
    });
    for (const [file, output] of outputs) fs.writeFileSync(file, output);
    console.log('Verified SmartCharts security backport; maintained standalone Lodash adapter installed.');
}
if (require.main === module) patch();
module.exports = { transform, patch, specifications };
