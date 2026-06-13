# @charmland/pi-hyper-provider

A [Pi] extension that registers [Charm Hyper] as a model provider, including
OAuth device-flow login, dynamic model discovery, and a credit-balance status
indicator.

[Pi]: https://github.com/earendil-works/pi/
[Charm Hyper]: https://hyper.charm.land

```sh
pi install npm:@charmland/pi-hyper-provider
```

## Usage

Once installed, select the `Charm Hyper` provider and log in via the device
flow. Models are fetched from the Hyper API at startup and cached locally; the
cache is used as a fallback when the API is unreachable. Your remaining credit
balance is shown in the status line while a Hyper model is active.

### Environment variables

- `HYPER_URL` — override the Hyper base URL (default `https://hyper.charm.land`).
- `HYPER_API_KEY` — API key used when not authenticating via OAuth.

## Development

Prerequisites: [mise] (installs Node automatically).

[mise]: https://mise.jdx.dev/

```sh
# Install dependencies
npm install

# Format, lint, and type-check
mise run check
```

### Releasing

```sh
mise run release:bump <patch|minor|major|prerelease|x.y.z> [--preid <id>]
mise run release:pack
mise run release:publish [--tag <tag>] [--otp <otp>]
```
