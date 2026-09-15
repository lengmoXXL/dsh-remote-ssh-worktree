/**
 * The glyph this plugin draws itself.
 *
 * The shared icon set has no terminal outline, and the guide's entry takes a
 * component rather than an element, so the prompt glyph is wrapped in
 * something with the `IconProps` shape.
 *
 * @module dsh-terminal/client/glyphs
 */

import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Draw a prompt: a frame holding a chevron and the cursor bar under it.
 * @param props - the guide's icon seat: size and an optional class.
 * @returns the terminal outline.
 */
export function TerminalGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="2.75" width="13" height="10.5" rx="2" />
      <path d="M4.5 6.25 6.75 8.25 4.5 10.25" />
      <path d="M8.5 10.5h3" />
    </svg>
  )
}
