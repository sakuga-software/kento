import type { Handle } from 'remix/component'

// Line icons on a 24 px grid, 1.75 px stroke, in the colour of the text. They are decorative: the
// text beside them names the action, so each one is aria-hidden.

function icon(paths: string[]) {
  return function Icon(_handle: Handle<{}>) {
    return () => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {paths.map((d) => (
          <path d={d} />
        ))}
      </svg>
    )
  }
}

export const DashboardIcon = icon(['M4 13h6V4H4z', 'M14 20h6v-9h-6z', 'M4 20h6v-3H4z', 'M14 7h6V4h-6z'])
export const ReposIcon = icon([
  'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z',
  'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3',
  'M9 7h6',
])
export const FindingsIcon = icon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-5-5', 'M11 8v3', 'M11 14h.01'])
export const RunnersIcon = icon(['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M8 8h.01', 'M8 16h.01', 'M12 8h4', 'M12 16h4'])
export const SettingsIcon = icon([
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
])
export const EyeIcon = icon(['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'])
export const AlertIcon = icon(['M12 3l10 18H2z', 'M12 10v4', 'M12 17h.01'])
export const CheckIcon = icon(['M20 6L9 17l-5-5'])
export const CloseIcon = icon(['M6 6l12 12', 'M18 6L6 18'])
export const ExternalIcon = icon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'])
export const SignOutIcon = icon(['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'])
export const LockIcon = icon(['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'])
export const MenuIcon = icon(['M4 7h16', 'M4 12h16', 'M4 17h16'])

/** The seal of Kentō: 検討 in white on vermilion, with its inner frame. From the design file of REV-91. */
function SealParts(_handle: Handle<{}>) {
  return () => (
    <>
      <rect class="mark-seal-bg" width="100" height="100" rx="8" />
      <rect x="5.5" y="5.5" width="89" height="89" rx="4" fill="none" stroke="#ffffff" stroke-width="2.5" />
      <g fill="#ffffff">
        <path transform="translate(28.4355 46.636) scale(0.043)" d="M391 79Q372 16 332 -37Q503 -72 563 -169H403V-361Q384 -344 365.0 -325.0Q346 -306 333 -291Q316 -308 295 -335V74H161V-231Q141 -192 120 -160Q98 -177 63.5 -196.0Q29 -215 1 -227Q33 -269 64.0 -326.5Q95 -384 119.0 -445.0Q143 -506 153 -555H45V-682H161V-834H295V-682H390V-632Q433 -664 473.0 -703.0Q513 -742 544.5 -781.5Q576 -821 594 -852L709 -835Q740 -793 789.5 -749.0Q839 -705 895.5 -666.5Q952 -628 1002 -604Q985 -592 967.0 -571.0Q949 -550 933.5 -527.5Q918 -505 908 -487Q871 -507 830 -539V-509H723V-470H915V-169H764Q813 -124 877.5 -89.5Q942 -55 999 -38Q972 -13 950.5 18.0Q929 49 915 75Q848 52 783.5 8.5Q719 -35 672 -90Q594 32 391 79ZM403 -417V-470H594V-509H482V-536Q463 -519 443.0 -504.0Q423 -489 404 -477Q394 -494 377.0 -515.0Q360 -536 343 -555H295V-535Q318 -507 347.5 -475.0Q377 -443 403 -417ZM577 -624H731Q708 -647 687.5 -669.5Q667 -692 651 -714Q638 -694 619.0 -671.0Q600 -648 577 -624ZM534 -282H594V-358H534ZM723 -282H783V-358H723Z" />
        <path transform="translate(28.414 86.862) scale(0.043)" d="M625 72Q624 52 619.0 23.5Q614 -5 607.5 -32.5Q601 -60 593 -77H674Q695 -77 704.5 -83.0Q714 -89 714 -110V-491H447V-561H48V-671H458V-618H714V-834H859V-618H956V-491H859V-46Q859 17 822.5 44.5Q786 72 712 72ZM85 63V-239H427V63ZM97 -703V-817H415V-703ZM96 -274V-385H415V-274ZM96 -417V-528H415V-417ZM571 -184Q549 -231 512.5 -285.0Q476 -339 441 -379L547 -454Q571 -429 597.0 -396.0Q623 -363 646.0 -328.0Q669 -293 685 -262Q659 -249 626.5 -226.5Q594 -204 571 -184ZM215 -48H296V-128H215Z" />
      </g>
    </>
  )
}

/** The mark of Kentō: the seal, then the word in the colour of the text. Under 760 px, the seal alone. */
export function Logo(_handle: Handle<{}>) {
  return () => (
    <>
      <svg class="mark-logo" viewBox="0 0 398.95 100" aria-hidden="true" focusable="false">
        <SealParts />
        <g fill="currentColor">
          <path transform="translate(117.4789 78) scale(0.0815)" d="M80 0V-687H271V-368L594 -687H834L548 -405L840 0H607L411 -283L271 -163V0Z" />
          <path transform="translate(187.6623 78) scale(0.0815)" d="M359 12Q260 12 188.5 -17.5Q117 -47 78.5 -108.0Q40 -169 40 -264Q40 -357 78.0 -418.0Q116 -479 186.0 -509.0Q256 -539 352 -539Q450 -539 519.0 -510.0Q588 -481 624.0 -421.0Q660 -361 660 -268V-229H219Q221 -187 236.5 -159.0Q252 -131 283.0 -117.0Q314 -103 360 -103Q386 -103 408.0 -109.0Q430 -115 447.0 -126.0Q464 -137 473.5 -152.0Q483 -167 484 -187H658Q658 -140 637.0 -103.0Q616 -66 576.5 -40.5Q537 -15 482.0 -1.5Q427 12 359 12ZM220 -323H477Q477 -348 468.5 -366.5Q460 -385 444.0 -398.0Q428 -411 406.0 -417.5Q384 -424 358 -424Q316 -424 287.0 -412.0Q258 -400 241.5 -377.5Q225 -355 220 -323Z" />
          <path transform="translate(244.722 78) scale(0.0815)" d="M64 0V-527H206L218 -446H226Q250 -478 281.5 -498.5Q313 -519 350.0 -529.0Q387 -539 426 -539Q493 -539 538.5 -516.5Q584 -494 607.5 -448.5Q631 -403 631 -333V0H456V-309Q456 -333 449.5 -351.5Q443 -370 431.0 -382.0Q419 -394 400.5 -400.0Q382 -406 359 -406Q325 -406 297.5 -391.0Q270 -376 254.0 -350.5Q238 -325 238 -292V0Z" />
          <path transform="translate(301.1295 78) scale(0.0815)" d="M288 12Q229 12 189.0 -3.5Q149 -19 129.0 -52.5Q109 -86 109 -141V-405H23V-527H115L150 -683H283V-527H408V-405H283V-178Q283 -145 296.5 -127.5Q310 -110 349 -110H408V-6Q395 -1 373.0 3.0Q351 7 328.0 9.5Q305 12 288 12Z" />
          <path transform="translate(337.2402 78) scale(0.0815)" d="M354 12Q257 12 186.5 -18.5Q116 -49 78.0 -110.0Q40 -171 40 -264Q40 -357 78.0 -418.0Q116 -479 186.5 -509.0Q257 -539 354 -539Q451 -539 521.5 -509.0Q592 -479 630.0 -418.0Q668 -357 668 -264Q668 -171 630.0 -110.0Q592 -49 521.5 -18.5Q451 12 354 12ZM354 -110Q400 -110 430.5 -127.0Q461 -144 475.5 -175.0Q490 -206 490 -249V-278Q490 -321 475.5 -352.5Q461 -384 430.5 -400.5Q400 -417 354 -417Q307 -417 277.0 -400.5Q247 -384 232.5 -352.5Q218 -321 218 -278V-249Q218 -206 232.5 -175.0Q247 -144 277.0 -127.0Q307 -110 354 -110ZM179 -609V-700H529V-609Z" />
        </g>
      </svg>
      <svg class="mark-seal" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <SealParts />
      </svg>
    </>
  )
}

/** The GitHub mark, for the sign-in button. */
export function GitHubIcon(_handle: Handle<{}>) {
  return () => (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  )
}
