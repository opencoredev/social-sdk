# Try Social SDK without connecting an account

Run the existing deterministic mock quickstart against the published npm package. This example does not contact a social platform or publish a real post. No tokens are needed.

## Run locally

Use Node.js 22.12 or newer. From this directory:

```sh
npm install
npm start
```

The console prints the mock destination outcomes. A `published` outcome here is simulated, not evidence of a live platform request.

The source is copied from [the mock quickstart](../snippets/mock-quickstart.ts). The package is pinned so a dependency update cannot silently change the lesson.

## What to inspect

Read the selected account in `targets`, the content, and the returned `outcomes`. Each target has its own outcome. Keep the mock in place while exploring this example; adding real accounts is a separate integration task.

For platform-specific availability and production setup, read the [Social SDK documentation](https://social-sdk.dev/docs/).
