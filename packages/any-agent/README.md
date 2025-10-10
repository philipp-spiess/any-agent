# tsdown-starter

A starter for creating a TypeScript package.

## Development

- Install dependencies:

```bash
npm install
```

- Run the unit tests:

```bash
npm run test
```

- Build the library:

```bash
npm run build
```

# any-agent

## Transcript export

While browsing sessions, press T to export the currently highlighted conversation to the local tmp directory of your current working directory:

- JSON: `./tmp/transcript-YYYY-MM-DDTHH-MM-SS.json`
- Markdown: `./tmp/transcript-YYYY-MM-DDTHH-MM-SS.md`

The Markdown export includes:

- Session header (source, model, timestamp, relative time, token usage, cost)
- User and assistant messages
- Tool calls with appropriate code fences (bash, diff, json, etc.)
