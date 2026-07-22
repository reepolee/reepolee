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
bun reepolee:install
bun dev
```

Run the relevant checks before opening a pull request:

```bash
bun test
```

Follow the repository conventions in `AGENTS.md`. In particular, fix generators
rather than editing generated output, keep server-side TypeScript identifiers in
snake_case, and avoid new runtime dependencies.

## Security

Do not report suspected vulnerabilities in a public issue. Follow
`SECURITY.md` instead.
