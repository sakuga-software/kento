import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { chooseOption, expectNoAxeViolations, hydrated, selectValue, signIn, watchConsole } from './helpers.ts'

// The Findings screen (REV-18) in a browser, against the server and Postgres: the pages of the list,
// the filters, and the empty state of a filter with its link to the closed findings.

const HEAD = 'a'.repeat(40)

/** 60 open findings on orchard, 3 dismissed on fruitback: each test starts from the same screen. */
async function seed() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard'), (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7002, 'sakuga-software/fruitback')
      on conflict (github_repo_id) do nothing`
    await sql`delete from findings`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha, github_comment_id, created_at)
      select repos.id, 40 + g % 4, md5('e2e' || g), md5('k' || g), 'src/vault/file_' || g || '.ts', g,
        'Finding ' || lpad(g::text, 2, '0') || ': the key is read without a check of its expiry',
        (array['critical', 'major', 'minor'])[1 + g % 3], (array['bug', 'security'])[1 + g % 2], 60 + g % 40, 'open',
        ${HEAD}, case when g % 5 = 0 then ${'b'.repeat(40)} else ${HEAD} end, 900000 + g, now() - g * interval '1 hour'
      from repos, generate_series(1, 60) g where repos.full_name = 'sakuga-software/orchard'`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        status_reason, first_seen_sha, last_seen_sha, created_at)
      select repos.id, 7, md5('d' || g), md5('dk' || g), 'app/widget.ts', g, 'Dismissed ' || g, 'minor', 'test', 55, 'dismissed',
        'Off topic', ${HEAD}, ${HEAD}, now() - g * interval '1 day'
      from repos, generate_series(1, 3) g where repos.full_name = 'sakuga-software/fruitback'`
    // REV-18: the dismissal of each of them, in the window of the precision.
    await sql`
      insert into finding_events (finding_id, type, actor, reason, created_at)
      select id, 'dismissed', 'octocat', status_reason, created_at + interval '1 hour' from findings where status = 'dismissed'`
  } finally {
    await sql.end()
  }
}

test.describe('the Findings screen', () => {
  for (let theme of ['paper', 'sumi'] as const) {
    test(`a member pages the open findings, filters them, and finds the closed ones from an empty filter (${theme})`, async ({
      page,
      context,
      baseURL,
    }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'camille')
      await seed()

      await page.goto('/findings')
      await expect(page.getByRole('heading', { level: 1, name: 'Findings' })).toBeVisible()
      let tabs = page.getByRole('navigation', { name: 'Status of the findings' })
      await expect(tabs.getByRole('link', { name: /open\s*60/ })).toHaveAttribute('aria-current', 'page')
      await expect(tabs.getByRole('link', { name: /closed\s*3/ })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(25)
      await expect(page.getByText('1 to 25 of 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader').first()).toContainText('Finding 01')
      await expectNoAxeViolations(page)

      // KNT-148: numbered pages, `?page=n`.
      let pager = page.getByRole('navigation', { name: 'Pages of the list' })
      await expect(pager.getByRole('link', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Next' }).click()
      await expect(page.getByText('26 to 50 of 60 findings')).toBeVisible()
      await expect(page).toHaveURL(/[?&]page=2(&|$)/)
      await pager.getByRole('link', { name: 'Page 3' }).click()
      await expect(page.getByText('51 to 60 of 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(10)
      await expect(pager.getByRole('link', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Page 1' }).click()
      await expect(page.getByText('1 to 25 of 60 findings')).toBeVisible()

      // P0 only: one in three.
      // REV-91: a filter applies on change, with no "Filter" button.
      await expect(page.getByRole('button', { name: 'Filter' })).toBeHidden()
      await chooseOption(page, 'Priority', { label: 'P0 · critical' })
      await expect(page).toHaveURL(/priority=critical/)
      await expect(page.getByRole('rowheader')).toHaveCount(20)

      // fruitback has no open finding: the empty state leads to its closed ones.
      await page.getByRole('link', { name: 'Clear the filters' }).first().click()
      await chooseOption(page, 'Repo', { label: 'fruitback' })
      await expect(page).toHaveURL(/repo=/)
      await expect(page.getByRole('heading', { name: 'No open finding for these filters' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('link', { name: 'See the 3 closed findings' }).click()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      await expect(page.getByText('Off topic').first()).toBeVisible()
      await expectNoAxeViolations(page)

      // REV-18: 3 dismissed and no fixed finding in 30 days: under 10, no share yet; the reason leads to its findings.
      // REV-91: the precision has its own tab.
      await page.goto('/findings')
      await page.getByRole('navigation', { name: 'Views of the findings' }).getByRole('link', { name: 'Precision' }).click()
      await expect(page).toHaveURL(/view=precision/)
      let precision = page.getByRole('region', { name: 'Precision · last 30 days' })
      await expect(precision.getByText('n = 3 of 10').first()).toBeVisible()
      await precision.getByRole('link', { name: 'Off topic' }).click()
      await expect(page).toHaveURL(/status=dismissed&reason=Off\+topic/)
      await expect(page.getByText('Reason "Off topic"')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      expect(errors).toEqual([])
    })
  }

  // REV-91: CSS decides the bar from the first paint, before findings.js (here never loaded) runs.
  test('the bar of actions shows once a finding is checked, with no wait for findings.js', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.route('**/assets/findings.js*', (route) => route.abort())
    await page.goto('/findings')
    // KNT-143: without findings.js, "Select all" stays hidden (`.check` keeps `hidden` working).
    await expect(page.locator('#findings-all')).toBeHidden()
    let bar = page.getByRole('group', { name: 'Actions on the checked findings' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await expect(bar).toBeVisible()
    await page.getByRole('checkbox', { name: /Finding 01/ }).uncheck()
    await expect(bar).toBeHidden()
  })

  // KNT-165: the selects of the filters are the select of @remix-run/ui once they hydrate: a
  // button named by its label and its value, a listbox, the keyboard of a select, and the same
  // name and value in a hidden input of the form.
  for (let theme of ['paper', 'sumi'] as const) {
    test(`a filter is a custom select: keyboard, screen reader names, focus, the form value (${theme})`, async ({ page, context, baseURL }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'octocat')
      await seed()
      // No rule: "Source" is disabled (rules.spec.ts starts from no rule too).
      let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
      await sql`delete from rules`
      await sql.end()
      await page.goto('/findings')
      await hydrated(page)
      // The native select is still in the page, hidden and disabled: the form posts the hidden input only.
      await expect(page.locator('select#findings-priority-native')).toBeHidden()
      await expect(page.locator('select#findings-priority-native')).toBeDisabled()
      await expect(selectValue(page, 'priority')).toHaveValue('')
      // "Source" is disabled when the org has no rule: then its hidden input is disabled too, and the
      // form does not post it, as a disabled native select (Kentō #117783).
      let source = page.getByRole('button', { name: /^Source / })
      await expect(source).toBeDisabled()
      await expect(selectValue(page, 'rule')).toBeDisabled()
      let trigger = page.getByRole('button', { name: 'Priority All' })
      await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      // The <label for> of the server now points at the button; it names it, with the value.
      await expect(page.locator('#findings-priority')).toHaveJSProperty('tagName', 'BUTTON')
      // The focus ring of a field, from the keyboard.
      await trigger.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(trigger).toBeFocused()
      expect(await trigger.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')

      // ArrowDown opens the list, on the chosen option; End, then Escape: nothing changes, the focus comes back.
      await page.keyboard.press('ArrowDown')
      let list = page.getByRole('listbox', { name: 'Priority' })
      await expect(list).toBeFocused()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await expect(list.getByRole('option', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
      await expect(list.getByRole('option')).toHaveCount(4)
      await expectNoAxeViolations(page)
      await page.keyboard.press('End')
      await expect(list.getByRole('option', { name: 'P2 · minor' })).toHaveAttribute('data-highlighted', 'true')
      await page.keyboard.press('Home')
      await expect(list.getByRole('option', { name: 'All' })).toHaveAttribute('data-highlighted', 'true')
      // Typeahead in the list: "P1".
      await page.keyboard.type('P1')
      await expect(list.getByRole('option', { name: 'P1 · major' })).toHaveAttribute('data-highlighted', 'true')
      await page.keyboard.press('Escape')
      await expect(list).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(page).not.toHaveURL(/priority=/)

      // Enter on an option: the value goes to the hidden input, and the filter applies (findings.js).
      await page.keyboard.press('ArrowDown')
      await expect(list).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/priority=critical/)
      await hydrated(page)
      await expect(page.getByRole('button', { name: 'Priority P0 · critical' })).toBeVisible()
      await expect(selectValue(page, 'priority')).toHaveValue('critical')
      await expect(page.getByRole('rowheader')).toHaveCount(20)
      await expectNoAxeViolations(page)
      expect(errors).toEqual([])
    })
  }

  test('in forced colors, the option under the pointer or the keyboard has an outline (KNT-165)', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/findings')
    await hydrated(page)
    await page.getByRole('button', { name: 'Priority All' }).focus()
    expect(await page.getByRole('button', { name: 'Priority All' }).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
    await page.keyboard.press('ArrowDown')
    let highlighted = page.locator('.select-popover:popover-open [role="option"][data-highlighted="true"]')
    await expect(highlighted).toHaveCount(1)
    expect(await highlighted.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
    // The check mark of the chosen option stays drawn, in the colour of the text.
    let mark = await page.locator('.select-popover:popover-open [aria-selected="true"]').evaluate((el) => {
      let after = getComputedStyle(el, '::after')
      return { adjust: after.forcedColorAdjust, color: after.backgroundColor, text: getComputedStyle(el).color }
    })
    expect(mark.adjust).toBe('none')
    expect(mark.color).toBe(mark.text)
  })

  // KNT-143 follow-up: a radio button of a group where nothing is checked matches :indeterminate.
  // The reasons of the dismiss dialog must still be drawn empty until one is chosen.
  for (let theme of ['paper', 'sumi'] as const) {
    test(`the reasons of "Mark dismissed…" are drawn empty until one is chosen (${theme})`, async ({ page, context, baseURL }) => {
      await signIn(page, 'octocat')
      await seed()
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/findings')
      await page.getByRole('checkbox', { name: /Finding 01/ }).check()
      await page.getByText('Mark dismissed…').click()
      let drawing = (name: string) =>
        page.getByRole('radio', { name }).evaluate((el) => {
          let style = getComputedStyle(el)
          let raised = document.createElement('span')
          raised.style.backgroundColor = 'var(--paper-raised)'
          document.body.append(raised)
          let sheet = getComputedStyle(raised).backgroundColor
          raised.remove()
          return { empty: style.backgroundColor === sheet, dot: getComputedStyle(el, '::before').scale }
        })
      for (let name of ['False positive', 'Off topic', 'Other']) expect(await drawing(name), name).toEqual({ empty: true, dot: '0' })
      await page.getByRole('radio', { name: 'Off topic' }).check()
      expect(await drawing('Off topic')).toEqual({ empty: false, dot: '1' })
      expect(await drawing('False positive')).toEqual({ empty: true, dot: '0' })
    })
  }

  // KNT-143: in forced colors (Windows High Contrast), the browser drops the drawn check mark, dot
  // and focus ring of kento.css. The native inputs come back, and the focus has an outline.
  test('in forced colors, the checkboxes and radio buttons are native, and the focus has an outline', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.emulateMedia({ forcedColors: 'active' })
    await page.goto('/findings')
    let row = page.getByRole('checkbox', { name: /Finding 01/ })
    await row.check()
    expect(await row.evaluate((el) => getComputedStyle(el).appearance)).toBe('auto')
    let radio = page.locator('input[type=radio][name=reason]').first()
    expect(await radio.evaluate((el) => getComputedStyle(el).appearance)).toBe('auto')
    // Keyboard focus, from the search field to the first box of a row.
    await page.locator('#findings-q').focus()
    expect(await page.locator('#findings-q').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
    for (let i = 0; i < 30 && !(await page.evaluate(() => document.activeElement?.matches('input.check') ?? false)); i++) {
      await page.keyboard.press('Tab')
    }
    let focused = await page.evaluate(() => {
      let el = document.activeElement as HTMLElement
      return { check: el.matches('input.check'), outline: getComputedStyle(el).outlineStyle }
    })
    expect(focused).toEqual({ check: true, outline: 'solid' })
    // The chevron of a select stays drawn, in the colour of the text of the field (FieldText).
    let chevron = await page.locator('.select--native').first().evaluate((el) => {
      let after = getComputedStyle(el, '::after')
      // KNT-165: the field on screen is the button of the custom select; the native one is hidden.
      return { adjust: after.forcedColorAdjust, color: after.backgroundColor, text: getComputedStyle(el.querySelector('.select__trigger:not([hidden])')!).color }
    })
    expect(chevron.adjust).toBe('none')
    expect(chevron.color).toBe(chevron.text)
  })

  test('an admin dismisses two findings "Off topic": both threads get the reply, and the reason counts two more', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await seed()
    let replies = async () =>
      (await (await fetch(`http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}/_test/replies`)).json()) as { commentId: number; body: string }[]
    let before = (await replies()).length

    let reasons = page.getByRole('region', { name: 'Precision · last 30 days' })
    await page.goto('/findings?view=precision')
    await expect(reasons.getByRole('link', { name: 'Off topic' }).locator('xpath=..')).toContainText('3')
    await page.goto('/findings')
    // KNT-143: findings.js shows "Select all".
    await expect(page.locator('#findings-all')).toBeVisible()
    // REV-91: the bar of the actions shows once a finding is checked, and "Deselect" empties it.
    let bar = page.getByRole('group', { name: 'Actions on the checked findings' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Deselect' }).click()
    await expect(bar).toBeHidden()
    await expect(page.getByRole('checkbox', { name: /Finding 01/ })).not.toBeChecked()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await page.getByRole('checkbox', { name: /Finding 02/ }).check()
    await expect(page.getByText('2 findings checked')).toBeVisible()
    await page.getByText('Mark dismissed…').click()
    await page.getByRole('radio', { name: 'Off topic' }).check()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Mark dismissed', exact: true }).click()

    await expect(page.getByText('2 findings marked dismissed.')).toBeVisible()
    await expect(page.getByText('2 replies posted in the GitHub threads.')).toBeVisible()
    await expect(page.getByRole('link', { name: /open\s*58/ })).toBeVisible()
    await page.goto('/findings?view=precision')
    await expect(reasons.getByRole('link', { name: 'Off topic' }).locator('xpath=..')).toContainText('5')
    let posted = (await replies()).slice(before)
    expect(posted.map((r) => r.commentId).sort()).toEqual([900001, 900002])
    expect(posted[0]!.body).toContain('by @octocat on Kentō. Reason: "Off topic"')
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })
})

test.describe('the Findings screen without JavaScript (KNT-165)', () => {
  test.use({ javaScriptEnabled: false })

  test('a filter is the native select, and "Filter" posts it', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.goto('/findings')
    let select = page.getByLabel('Priority')
    await expect(select).toHaveJSProperty('tagName', 'SELECT')
    await select.selectOption({ label: 'P0 · critical' })
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page).toHaveURL(/priority=critical/)
    await expect(page.getByRole('rowheader')).toHaveCount(20)
  })
})
