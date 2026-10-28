// The text of the review threads, with no git and no network: the web service imports it too, to
// clean the comments that it sends to a runner and to find the threads already answered.
/** The mark of a reply of `resolve` at a head: a thread with it waits for a new push. */
export const markerResolve = (head: string) => `<!-- sakuga-review:resolve ${head.slice(0, 12)} -->`;

/** The most characters of one comment of a thread that the model reads. */
export const MAX_THREAD_COMMENT_CHARS = 2000;

const TRUNCATED = '[… coupé ici]';

/** The text cut to a size, with a mark that the model sees when the cut drops something. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n${TRUNCATED}` : text;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const DETAILS_BLOCK = /<details>[\s\S]*?<\/details>/g;
const MEDIA_TAG = /<(img|a|picture|source)\b[^>]*>/g;

/** A removal can join the text around it into a new match: `<!<!---->-- x -->`. Repeat until the text is stable. */
function removeAll(text: string, pattern: RegExp): string {
  let current = text;
  for (let previous = ''; previous !== current;) {
    previous = current;
    current = current.replace(pattern, '');
  }
  return current;
}

export const cleanBody = (body: string) =>
  cut(
    removeAll(removeAll(removeAll(body, HTML_COMMENT), DETAILS_BLOCK), MEDIA_TAG)
      .trim(),
    MAX_THREAD_COMMENT_CHARS,
  );

