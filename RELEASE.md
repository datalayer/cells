<!--
  ~ Copyright (c) 2022-2026 Datalayer, Inc.
  ~
  ~ MIT License
-->

# Making a release

A tag releases both packages, with no stored token: npm and PyPI trust
`.github/workflows/release.yaml` through OIDC (trusted publishing).

| Package            | Registry | GitHub environment |
| ------------------ | -------- | ------------------ |
| `@datalayer/cells` | npm      | `npm`              |
| `datalayer-cells`  | PyPI     | `pypi`             |

Both carry **one version**. It lives in `datalayer_cells/__version__.py`,
which hatch reads; `package.json` carries a copy. `dev/bump_version.py` moves
them together, or refuses when they disagree:

```bash
make bump-patch    # 1.0.3 -> 1.0.4
make bump-minor    # 1.0.3 -> 1.1.0
make bump-major    # 1.0.3 -> 2.0.0
```

## Steps

1. `make bump-patch` (or minor, major), commit, and push (or open a pull
   request). CI (`ci.yaml`) lints, type-checks, builds and tests the
   TypeScript package, tests the Python package on 3.10, 3.12 and 3.13, and
   builds its wheel.

1. Once CI is green, tag that commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

1. The `Release` workflow checks that the tag names the version both packages
   carry, builds and tests them, publishes to npm and to PyPI what is not
   published yet, and creates a GitHub release with generated notes. A
   version already on a registry is skipped, so a re-run finishes a partial
   release.

## Trusted publishing

- npm package `@datalayer/cells`: repository `datalayer/cells`, workflow
  `release.yaml`, environment `npm`.
- PyPI project `datalayer-cells`: repository `datalayer/cells`, workflow
  `release.yaml`, environment `pypi`.
