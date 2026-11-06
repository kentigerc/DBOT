This private compatibility fork retains deepmerge 4.3.1's API and MIT license.
The build suffix `+neto.1` identifies this local security backport.
It fixes GHSA-gcqx-w48m-w2h4 by filtering `__proto__`, `constructor` and `prototype`
from both target and source keys before cloning or assigning them. In particular,
the upstream source-only check did not protect the initial target-copy loop.

The original CJS source checksum and provenance are in package.json. No upstream
version number is impersonated. This fork is checked into the repository and used
by the tour components through a direct local-file dependency, deduplicated for compatible consumers. Keep its tests and review
upstream updates; npm audit alone does not inspect the fork's implementation.
