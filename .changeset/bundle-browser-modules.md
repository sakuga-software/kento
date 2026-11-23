---
"@kento-review/web": patch
---

pr: #51

**Browser modules** (KNT-170): the image bundles them at build time (a `client` stage, esbuild): a
few files under `/assets/js/` (8 today), compressed with brotli and gzip, named by their hash,
cached a year, instead of some 70 modules compiled on request under `/assets/app/`, `/assets/c/`…
A cold load of a page with components makes about 60 fewer requests and hydrates about twice as
fast on a slow network. Nothing to change in the proxy (`/assets/` still goes to the service). An
install that runs the source without the image runs `pnpm build:client` before `pnpm start`;
without it, the service logs `startup.client_build_missing` and serves the modules one by one, as
before. The pages no longer carry an import map; the content security policy is unchanged.
