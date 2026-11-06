This private adapter replaces the unmaintained lodash.set package with maintained
lodash/set while preserving its callable API. The chart package also embeds its
own old setter; the checksummed build-time patch and regression test in
scripts/patch-vendor-security.cjs and server/vendor-security.test.cjs protect that
separate copy. Removing only the npm dependency is insufficient.
