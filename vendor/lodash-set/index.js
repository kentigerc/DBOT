// Preserve lodash.set's callable CommonJS API while using the maintained setter.
// SmartCharts also embeds a copy; scripts/patch-vendor-security.cjs separately
// backports its prototype-path guard before any application build.
module.exports = require('lodash/set');
