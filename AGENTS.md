# AGENTS.md

Pi package integrating Charm's Hyper inference provider with the rest of Pi.

- Follow Conventional Commits of the form `<type>(<scope>): <description>`.
- Do not commit with explicit user instruction to.
- Never open PRs yourself. You may only provide commands to do so and let the
  user open PRs themselves.

## Commands

Use `mise` to automatically apply the configured Node version and task wrappers.

```sh
mise run fmt # format all files with Biome; run often
mise run lint # lint all files with Biome; run often
mise run typecheck # check types with tsc; run often
mise run check # fmt, lint, then typecheck sequentially; run before committing/ending your turn
mise run lint ::: typecheck # lint and typecheck in parallel
```

Release tasks are custom and run `mise run check` internally:

```sh
mise run release:bump -- <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z>
mise run release:pack
mise run release:publish -- --tag <tag> [--otp <otp>]
```

## Gotchas

- There is no test script in this package right now; validate with the narrowest
  relevant command above, then `mise run check` when feasible.
- Do not bypass `mise` with raw `npm` unless strictly necessary; mise tasks may
  do additional work.
