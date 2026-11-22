// The text of the review threads, with no git and no network: the web service imports it too, to
// clean the comments that it sends to a runner and to find the threads already answered.
/** The mark of a reply of `resolve` at a head: a thread with it waits for a new push. */
export const markerResolve = (head: string) => `<!-- sakuga-review:resolve ${head.slice(0, 12)} -->`;

/** The most characters of one comment of a thread that the model reads. */
export const MAX_THREAD_COMMENT_CHARS = 2000;

const TRUNCATED = '[… cut here]';

/** The text cut to a size, with a mark that the model sees when the cut drops something. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n${TRUNCATED}` : text;
}

/**
 * Removes each span from `open` to the first `close` after it, in one scan: a regular expression such
 * as `<!--[\s\S]*?-->` reads the rest of the text from each opener, and a long text of openers with
 * no closer makes it quadratic. An opener with no closer stays, as with that expression.
 */
function removeSpans(text: string, open: string, close: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const start = text.indexOf(open, pos);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    out += text.slice(pos, start);
    pos = end + close.length;
  }
  return out + text.slice(pos);
}

const MEDIA_NAME = /^<(img|a|picture|source)\b/;

/** Removes each `<img …>`, `<a …>`, `<picture …>` and `<source …>` tag, in one scan. */
function removeMediaTags(text: string): string {
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    if (lt < 0) break;
    // The longest name, `<picture`, and the character after it.
    if (!MEDIA_NAME.test(text.slice(lt, lt + 9))) {
      from = lt + 1;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt < 0) break;
    out += text.slice(pos, lt);
    pos = from = gt + 1;
  }
  return out + text.slice(pos);
}

/** A removal can join the text around it into a new match: `<!<!---->-- x -->`. Repeat until the text is stable. */
function removeAll(text: string, remove: (text: string) => string): string {
  let current = text;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = remove(current);
  }
  return current;
}

export const cleanBody = (body: string) =>
  cut(
    removeAll(
      removeAll(
        removeAll(body, (t) => removeSpans(t, '<!--', '-->')),
        (t) => removeSpans(t, '<details>', '</details>'),
      ),
      removeMediaTags,
    )
      .trim(),
    MAX_THREAD_COMMENT_CHARS,
  );

