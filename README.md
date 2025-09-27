# any-agent workspace

This repository is organized as a Bun workspaces monorepo. The existing CLI now lives in [`packages/any-agent`](packages/any-agent), preserving its original package metadata and build tooling.

To install dependencies for all packages, run:

```sh
bun install
```

From there you can run package scripts with Bun's workspace filter flag. For example, to run tests for the CLI package:

```sh
bun run --filter any-agent test
```

See the package README for detailed usage instructions.
