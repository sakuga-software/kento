/*
 * Icons from Lucide (https://lucide.dev), copied as data: no icon font, no package (KNT-146). Taken
 * from lucide-react 0.469.0; the stroke is 1.75 px, as in icons.tsx.
 *
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All
 * other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without
 * fee is hereby granted, provided that the above copyright notice and this permission notice appear
 * in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
 * SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
 * OF THIS SOFTWARE.
 */
import type { Handle } from 'remix/component'

/** One shape of an icon, as Lucide writes it. */
export type IconNode =
  | ['path', { d: string }]
  | ['circle', { cx: number; cy: number; r: number }]
  | ['rect', { x: number; y: number; width: number; height: number; rx: number }]

export interface IconProps {
  /** A class for the `<svg>`, for a size or a place that the CSS of the parent does not give. */
  class?: string
}

/**
 * An icon component from the shapes of a Lucide icon: 24 px grid, the colour of the text. The text
 * beside it names the action or the state, so the icon is decorative: `aria-hidden`, and no focus.
 */
export function lucide(nodes: IconNode[]) {
  return function LucideIcon(handle: Handle<IconProps>) {
    return () => (
      <svg
        class={handle.props.class}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {nodes.map(([tag, attrs]) =>
          tag === 'path' ? (
            <path d={attrs.d} />
          ) : tag === 'circle' ? (
            <circle cx={attrs.cx} cy={attrs.cy} r={attrs.r} />
          ) : (
            <rect x={attrs.x} y={attrs.y} width={attrs.width} height={attrs.height} rx={attrs.rx} />
          ),
        )}
      </svg>
    )
  }
}

export const BookMarkedIcon = lucide([
  ['path', { d: 'M10 2v8l3-3 3 3V2' }],
  ['path', { d: 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20' }],
])
export const ChevronLeftIcon = lucide([['path', { d: 'm15 18-6-6 6-6' }]])
export const ChevronRightIcon = lucide([['path', { d: 'm9 18 6-6-6-6' }]])
export const CircleCheckIcon = lucide([
  ['circle', { cx: 12, cy: 12, r: 10 }],
  ['path', { d: 'm9 12 2 2 4-4' }],
])
export const CircleDashedIcon = lucide([
  ['path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }],
  ['path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }],
  ['path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
  ['path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }],
  ['path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
  ['path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }],
  ['path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
  ['path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
])
export const CircleHelpIcon = lucide([
  ['circle', { cx: 12, cy: 12, r: 10 }],
  ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
  ['path', { d: 'M12 17h.01' }],
])
export const GlobeIcon = lucide([
  ['circle', { cx: 12, cy: 12, r: 10 }],
  ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
  ['path', { d: 'M2 12h20' }],
])
export const ListChecksIcon = lucide([
  ['path', { d: 'm3 17 2 2 4-4' }],
  ['path', { d: 'm3 7 2 2 4-4' }],
  ['path', { d: 'M13 6h8' }],
  ['path', { d: 'M13 12h8' }],
  ['path', { d: 'M13 18h8' }],
])
export const PowerIcon = lucide([
  ['path', { d: 'M12 2v10' }],
  ['path', { d: 'M18.4 6.6a9 9 0 1 1-12.77.04' }],
])
export const PowerOffIcon = lucide([
  ['path', { d: 'M18.36 6.64A9 9 0 0 1 20.77 15' }],
  ['path', { d: 'M6.16 6.16a9 9 0 1 0 12.68 12.68' }],
  ['path', { d: 'M12 2v4' }],
  ['path', { d: 'm2 2 20 20' }],
])
export const RefreshCwIcon = lucide([
  ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
  ['path', { d: 'M21 3v5h-5' }],
  ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
  ['path', { d: 'M8 16H3v5' }],
])
export const SearchIcon = lucide([
  ['circle', { cx: 11, cy: 11, r: 8 }],
  ['path', { d: 'm21 21-4.3-4.3' }],
])
export const SlidersIcon = lucide([
  ['path', { d: 'M20 7h-9' }],
  ['path', { d: 'M14 17H5' }],
  ['circle', { cx: 17, cy: 17, r: 3 }],
  ['circle', { cx: 7, cy: 7, r: 3 }],
])
