# Releasing Turntrail

Release artifacts are built by GitHub Actions from an immutable version tag. VSIX files under
`dist/` are local build output and must never be committed.

## Release Checklist

1. Update the version in the root, core, CLI, and VS Code package manifests, including internal
   `@turntrail/core` dependency versions.
2. Run `npm install --package-lock-only --ignore-scripts` to update lock metadata.
3. Run `npm ci --ignore-scripts`, `npm test`, `npm run lint`, and `npm audit` from a clean checkout.
4. Merge the version commit to `main` and wait for the required CI and CodeQL checks.
5. Create and push the matching annotated tag, such as `v0.12.1`.

The tag-triggered release workflow repeats all gates, packages the extension, produces
`SHA256SUMS.txt`, creates a signed build-provenance attestation, and attaches both files to the
GitHub release. It refuses a tag that does not exactly match package metadata.

Verify a downloaded artifact with:

```bash
sha256sum --check SHA256SUMS.txt
gh attestation verify turntrail-<version>.vsix --repo yagyaanshK/turntrail
```
