# web — the Next.js frontend

A Next.js 16 App Router app, kept separate from the API at the repository root.
It has its own `package.json`, lockfile and TypeScript config, and shares
nothing with the API but the repository.

```bash
cd web
npm install
npm run dev     # http://localhost:3000
npm run build
```

`turbopack.root` is pinned in `next.config.ts` because two lockfiles live in
this repository; without it Next picks the API's lockfile and resolves modules
from the wrong directory.

## Status: not the published site

The API serves its own landing page from `public/` at the root of the
repository. That page is the one written for crawlers and for agents deciding
whether to integrate, and it is what the discovery directory indexes. This app
is not wired to anything and nothing depends on it.

## Before this can be published

The page began as a port of a Token Terminal marketing page, and most of its
content is still theirs. The layout metadata has been changed to AlgoTerminal,
but the following still carry another company's identity and must be replaced
or removed first:

- `components/Testimonials.tsx` — quotes attributed to named real people
- `components/TrustedBy.tsx` — real firms' logos under a "trusted by" heading
- `public/assets/avatars/` — photographs of real individuals
- `public/assets/logos/` — third-party company logos
- `components/Platform.tsx`, `Solutions.tsx`, `Fundamentals.tsx` — copy
  describing a different product

Publishing any of that under AlgoTerminal's name would claim endorsements that
were never given and present another company's material as our own.
AlgoTerminal is *modelled on* Token Terminal's approach to standardizing
metrics; it is not Token Terminal, and the site must not suggest otherwise.

The port itself is sound work and worth keeping: it reproduces the original
layout to within 13 of 11.2 million pixels and fixed five real HTML defects
along the way. What needs replacing is the content, not the code.
