# apps/web: notes for agents

The service is described in [README.md](README.md). This file keeps the rules that a change of a
screen must follow.

## UI components

- **Form controls are native elements**: `<button>`, `<input>`, `<select>`, `<textarea>`. Write them
  through `app/ui/controls.tsx` (`Button`, `buttonClass` for a link or a `<summary>` that looks like
  a button, `Input`, `Textarea`, `Select`, `Choice`, `Check` for a checkbox repeated on every row,
  `Field`). `public/assets/kento.css` draws them with the tokens of Paper and Sumi; a screen adds only
  its layout.
- **No React, and no third-party component or CSS framework.** The screens are `remix/component`
  JSX rendered on the server, and the styles are plain CSS in `kento.css`.
- **Interactive widgets** (menu, popover, select, tabs, toast) use the headless primitives of
  `@remix-run/ui` (pinned to the version that matches the `remix` of the repo), styled by `kento.css`.
  Each one is a component that hydrates (KNT-163):
  - It lives in an `app/**/public/` folder (`app/ui/public/row-menu.tsx`, `confirm.tsx`) and is
    wrapped in `clientEntry(import.meta.url, function Name(…))`. The asset server of Remix
    (`app/assets.ts`) compiles it when the browser asks: there is still no build step. A browser
    module imports only `remix/component`, `@remix-run/ui/*`, another `public/` module, or a file
    that `ALLOWED_FILES` of `app/assets.ts` lists (the routes, the controls, the icons). The asset
    server refuses any other file of the server.
  - The server renders the fallback without JavaScript (`<details>`, a link, a form, a native
    `<select>`), and the first render in the browser is the same markup, to hydrate it. The widget
    switches to the primitive in a `handle.queueTask()` of its setup, which runs only in the browser.
  - Its props cross to the browser in the page (`<script id="rmx-data">`): keep them few and small
    (ids, not URLs; no icon), above all in a row of a list. A page without such a component loads no
    runtime: `public/boot.ts` loads `public/runtime.ts` only when there is one to hydrate.
  - The runtime does not take over the links and the forms (no client navigation): a navigation is
    a document load, so that the scripts of `public/assets/` keep working.
  - A closed popover is hidden by the browser, unless a class of `kento.css` sets `display`: give it
    a `:not(:popover-open) { display: none }` rule then. Give the hydrated markup its own classes: the
    structural rules of the fallback (`.row-menu > div`) would apply to it too.
  - e2e: `hydrated(page)` (`e2e/helpers.ts`) waits for the runtime; test the widget with JavaScript
    and its fallback in a `test.use({ javaScriptEnabled: false })` block.
- **Scripts.** The content security policy allows the scripts of the app (`'self'`) and one inline
  script, the import map, with the nonce of the response (`app/ui/security-headers.ts`, the `csp()`
  middleware of Remix). Never an inline script or style of your own. A small script in
  `public/assets/` still fits a behaviour of a whole page (`progress.js`, `findings.js`).
- **Forms keep working without JavaScript.** A script may apply a choice at once or reveal a
  control, never be the only way to submit.
- **Every control passes the accessibility checks**:
  - a visible focus ring, from the keyboard;
  - a contrast of 4.5:1 at least for its text, against its own background or the one behind it
    (`expectReadableButtons` in `e2e/helpers.ts`, with axe);
  - forced colors (Windows High Contrast): a native checkbox and radio button, and an outline in
    `Highlight` on focus;
  - `[hidden]` still hides it: a class that sets `display` needs its own `[hidden]` rule.
- **Weight of a list.** A control repeated on every row of a long list stays a single element with
  one class (`Check`), so that the pages keep their budget of HTML (`test/db/*-volume.test.ts`).
