# Contributing to Reepolee

Reepolee is open source under the MIT License and maintained by Reepolee Labs.
You may use, modify, and redistribute the software under those terms.

The project remains maintainer-led. Changes are accepted when they fit the
architecture, product direction, and long-term maintenance standard.

## Before proposing a change

- Start with a concrete problem from real use.
- Search existing issues before opening another one.
- Include the smallest reproduction you can provide for a bug.
- Include your Reepolee version, Bun version, and what you already tried.
- Discuss substantial features before investing in an implementation.

Small fixes with focused tests are welcome. A public repository is not a
promise to merge every feature or preserve every proposed abstraction.

## Development

```bash
bun install
bun dev
```

Run the relevant checks before opening a pull request:

```bash
bun test
```

Follow the repository conventions in `AGENTS.md`. In particular, fix generators
rather than editing generated output, keep server-side TypeScript identifiers in
snake_case, and avoid new runtime dependencies.

## Release overrides

Some config files ship with different defaults than what you develop with. A file named `foo.override.ts` next to `foo.ts` is packed in place of the original when `reelease` creates a distribution archive - the override becomes `foo.ts` in the release, and the `.override.ts` file itself is never included.

The canonical example is `config/supported_locales.ts`. The release ships with only `["en-us"]` so new users start with a single locale. To add another locale for your own development, run:

```sh
bun reeman add-locale <locale_code>   # e.g. bun reeman add-locale sl-si
```

### Keeping overrides in sync

Each `.override.ts` file carries a hash of the original on its first line:

```ts
// @release-sync-hash: d181dcfa
```

The release packager checks this hash before packing. If the original file has changed since the hash was recorded, the release fails with a message telling you which file is affected. The workflow is:

1. Edit the original `foo.ts` as needed.
2. Update `foo.override.ts` to reflect any structural changes (new exports, removed exports).
3. Use the current maintainer release tooling to update the hash and validate the package.

The hash comment is stripped automatically before the override is packed, so it never appears
in the distributed file. This checkout does not provide release-update commands; do not invent
or run an old command from documentation without maintainer direction.

## Security

Do not report suspected vulnerabilities in a public issue. Follow `SECURITY.md` instead.
