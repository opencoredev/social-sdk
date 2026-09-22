# @opencoredev/social-sdk

## 0.1.2

### Patch Changes

- 4b6b3b3: Document the supported Node.js and Bun runtimes in the package README.

## 0.1.1

### Patch Changes

- 75c6634: Run the CLI when invoked through the installed bin symlink. The entry guard now resolves the invoked path before comparing it to the module URL, so `social-sdk` from node_modules/.bin executes instead of exiting silently.

## 0.1.0

### Minor Changes

- dfb0234: Introduce the independent Social SDK prerelease, modular client contracts, deterministic testing backend, direct and managed social integrations, and server-side connection and event helpers. Replace the inherited documentation with Blume.
- dfb0234: Expand direct platform adapters with typed native parity operations for media, engagement, profiles, feeds, captions, playlists, analytics, and platform-specific publishing workflows. Capability manifests and platform documentation now record supported, gated, and unsupported operations.
