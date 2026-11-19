# Third-party notice: the Martian Code Review Bench

Parts of this folder come from the [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark):

- the judge prompt (`JUDGE_PROMPT` in [`run.ts`](run.ts));
- the pull requests of `source: "martian"` in [`subset-ts.json`](subset-ts.json),
  [`subset-ts-v2.json`](subset-ts-v2.json) and [`subset-ts-hard.json`](subset-ts-hard.json), with
  their golden comments;
- the scoring profiles of [`profiles.ts`](profiles.ts).

They are used under the license of that repository:

```text
MIT License

Copyright (c) 2025 Martian (withmartian.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
