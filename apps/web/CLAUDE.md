# apps/web: notes for agents

The service is described in [README.md](README.md). This file keeps the rules that a change of a
screen must follow, and the one of every pull request.

## Every pull request

- **Add a changeset** that names `@kento-review/web`: `pnpm changeset`, or `pnpm changeset --empty`
  when nobody who runs Kentō sees the change. Never edit the sections of CHANGELOG.md by hand
  ([CONTRIBUTING.md, "Changesets"](../../CONTRIBUTING.md#changesets)).

## UI components

- **Form controls are native elements**: `<button>`, `<input>`, `<select>`, `<textarea>`. Write them
  through `app/ui/controls.tsx` (`Button`, `buttonClass` for a link or a `<summary>` that looks like
  a button, `Input`, `Textarea`, `Select`, `Choice`, `Check` for a checkbox repeated on every row,
  `Field`). `public/assets/kento.css` draws them with the tokens of Paper and Sumi; a screen adds only
  its layout.
- **No React, and no third-party component or CSS framework.** The screens are `remix/component`
  JSX rendered on the server, and the styles are plain CSS in `kento.css`.
- **Interactive widgets** (menu, popover, tabs, toast) use the headless primitives of
  `@remix-run/ui` once the app has client hydration (KNT-163), and always keep a fallback without
  JavaScript. Until then, a widget is a native element (`<details>`, a link, a form) with a small
  script in `public/assets/`.
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
