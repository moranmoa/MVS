// G-48: report to the owners (core #515; PO decisions 1–4): the report dialog
// from a message or a member, and the owner's "Reports" page.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app/App';
import type { Settings } from '../app/settings';
import { MockCore } from '../core/mock';
import { cleanReportEvidence, cleanReportSummary } from '../core/sanitize';
import type { ReportSummary } from '../core';

const en: Settings = { locale: 'en', theme: 'light', uiScale: 1, fontSize: 15 };

// `prepare` runs before the app starts (the sanitizer wraps the core then).
async function setup(prepare?: (core: MockCore) => void) {
  const core = new MockCore({ demo: true, speed: 0, simulateActivity: false });
  prepare?.(core);
  render(<App core={core} initialSettings={en} />);
  await screen.findByRole('textbox', { name: /^Message / });
  return { core };
}
const click = async (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });
const menuItem = (name: string) => screen.getByRole('menuitem', { name });

async function reportFirstOthersMessage() {
  const myName = screen.getByRole('complementary', { name: 'Channels' }).querySelector('.me-name')!.textContent!;
  const others = () => screen.getAllByRole('article').filter((a) => a.getAttribute('aria-haspopup') && !a.textContent?.includes(myName));
  await waitFor(() => {
    fireEvent.contextMenu(others()[0]!);
    expect(menuItem('Report')).toBeTruthy();
  });
  await click(menuItem('Report'));
  return screen.getByRole('dialog', { name: 'Report a message' });
}

const summary = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  id: 'r1',
  serverId: 's-gamers',
  reporterId: 'u-1',
  target: { kind: 'message', messageId: 'c-general#5', channelId: 'c-general' },
  reportedId: 'u-2',
  reason: 'spam',
  ts: 1_700_000_000_000,
  receivedAt: 1_700_000_001_000,
  dismissed: false,
  evidenceValid: true,
  evidenceWithheld: false,
  ...over,
});

describe('G-48: the sanitizer', () => {
  it('keeps a known reason and target, one-line text; never evidence; withheld unless the core says not', () => {
    expect(cleanReportSummary({ ...summary(), reason: 'nope' } as never)).toBeNull();
    expect(cleanReportSummary({ ...summary(), target: { kind: 'channel' } } as never)).toBeNull();
    const r = cleanReportSummary({ ...summary(), text: 'a\nb', evidence: 'leak', evidenceWithheld: undefined } as never)!;
    expect(r.text).toBe('a b');
    expect(r).not.toHaveProperty('evidence');
    expect(r.evidenceWithheld).toBe(true);
    expect(cleanReportEvidence({ authorId: 'u', channelId: 'c', ts: 5, text: 'hi' })).toEqual({ authorId: 'u', channelId: 'c', ts: 5, text: 'hi' });
    expect(cleanReportEvidence({ authorId: 'u', channelId: 'c', ts: 5 })).not.toHaveProperty('text');
  });
});

describe('G-48: reporting', () => {
  it('a message: pick a reason (send waits for one), says staff will see who sent it, then sent', async () => {
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    await setup((core) => {
      spy = vi.spyOn(core, 'reportContent');
    });
    const dialog = await reportFirstOthersMessage();
    expect(within(dialog).getByText(/The owner and admins will see that you reported this\./)).toBeTruthy();
    const send = within(dialog).getByRole('button', { name: 'Send report' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await click(within(dialog).getByRole('radio', { name: 'Spam' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: '  same   link everywhere ' } });
    await click(send);
    expect(spy).toHaveBeenCalledWith(expect.any(String), { kind: 'message', messageId: expect.any(String) }, 'spam', 'same link everywhere');
    expect(await within(dialog).findByText('Your report was sent to the owner and admins.')).toBeTruthy();
  });

  it('reason 6: the 105 line, before and after sending (PO 3)', async () => {
    await setup();
    const dialog = await reportFirstOthersMessage();
    const line = /105 hotline, the National Child Online Protection Center/;
    expect(within(dialog).queryByText(line)).toBeNull();
    await click(within(dialog).getByRole('radio', { name: 'Involves a minor' }));
    expect(within(dialog).getByText(line)).toBeTruthy();
    await click(within(dialog).getByRole('button', { name: 'Send report' }));
    await within(dialog).findByText('Your report was sent to the owner and admins.');
    expect(within(dialog).getByText(line)).toBeTruthy();
  });

  it('the same message again: already reported', async () => {
    await setup();
    let dialog = await reportFirstOthersMessage();
    await click(within(dialog).getByRole('radio', { name: 'Spam' }));
    await click(within(dialog).getByRole('button', { name: 'Send report' }));
    await within(dialog).findByText('Your report was sent to the owner and admins.');
    await click(dialog.querySelector('.actions .primary')!);
    dialog = await reportFirstOthersMessage();
    await click(within(dialog).getByRole('radio', { name: 'Hate speech' }));
    await click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('You already reported this in the last 30 days.');
  });

  it('nobody to receive it: says so', async () => {
    await setup((core) => vi.spyOn(core, 'reportContent').mockRejectedValue({ code: 'no-recipient' }));
    const dialog = await reportFirstOthersMessage();
    await click(within(dialog).getByRole('radio', { name: 'Spam' }));
    await click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe("There's no one in this server who can receive this report.");
  });

  it('a member, from the member menu', async () => {
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    await setup((core) => {
      spy = vi.spyOn(core, 'reportContent');
    });
    const list = screen.getByRole('complementary', { name: 'Server members' });
    const other = within(list)
      .getAllByRole('button', { name: /profile/ })
      .find((r) => !r.textContent?.includes('(you)'))!;
    fireEvent.contextMenu(other);
    await click(menuItem('Report'));
    const dialog = screen.getByRole('dialog', { name: 'Report an account' });
    await click(within(dialog).getByRole('radio', { name: 'Impersonation' }));
    await click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect(spy).toHaveBeenCalledWith(expect.any(String), { kind: 'member', userId: expect.any(String) }, 'impersonation', undefined);
  });
});

async function openReports() {
  const sidebar = screen.getByRole('complementary', { name: 'Channels' });
  fireEvent.click(within(sidebar).getByRole('button', { name: 'Server settings' }));
  const dialog = screen.getByRole('dialog');
  await click(within(dialog).getByRole('tab', { name: 'Reports' }));
  return within(dialog).getByRole('tabpanel', { name: 'Reports' });
}

describe("G-48: the owner's Reports page", () => {
  it('lists reports without content; "Show content" fetches it, as plain text', async () => {
    let evidence: ReturnType<typeof vi.spyOn> | undefined;
    await setup((core) => {
      evidence = vi.spyOn(core, 'getReportEvidence');
    });
    const panel = await openReports();
    const items = await within(panel).findAllByRole('listitem');
    expect(items.length).toBe(3);
    expect(evidence).not.toHaveBeenCalled();
    const spam = items.find((li) => li.textContent?.includes('Spam'))!;
    await click(within(spam).getByRole('button', { name: 'Show content' }));
    const quote = spam.querySelector('blockquote.report-evidence')!;
    expect(quote).toBeTruthy();
    expect(quote.querySelector('a, strong, em, code')).toBeNull();
  });

  it('reason 5: a warning before the content (PO 1)', async () => {
    let evidence: ReturnType<typeof vi.spyOn> | undefined;
    await setup((core) => {
      evidence = vi.spyOn(core, 'getReportEvidence');
    });
    const panel = await openReports();
    const items = await within(panel).findAllByRole('listitem');
    const sexual = items.find((li) => li.textContent?.includes('Sexual content'))!;
    await click(within(sexual).getByRole('button', { name: 'Show content' }));
    expect(within(sexual).getByRole('alertdialog')).toBeTruthy();
    expect(evidence).not.toHaveBeenCalled();
    await click(within(sexual).getByRole('button', { name: 'Show' }));
    expect(evidence).toHaveBeenCalledTimes(1);
  });

  it('withheld for staff under 18: says why, and never asks the core (PO 2)', async () => {
    const getEvidence = vi.fn();
    await setup((core) => {
      vi.spyOn(core, 'listReports').mockResolvedValue([summary({ reason: 'sexual', evidenceWithheld: true })]);
      core.getReportEvidence = getEvidence;
    });
    const panel = await openReports();
    const item = await within(panel).findByRole('listitem');
    await click(within(item).getByRole('button', { name: 'Show content' }));
    expect(within(item).getByText('The content is hidden because it may not be suitable for your age.')).toBeTruthy();
    expect(getEvidence).not.toHaveBeenCalled();
    // Still able to act on it.
    expect(within(item).getByRole('button', { name: 'Delete the message' })).toBeTruthy();
  });

  it('reason 6: delete first, the 105 line, and the content can\'t be copied (PO 3, 4)', async () => {
    await setup((core) => {
      vi.spyOn(core, 'listReports').mockResolvedValue([summary({ reason: 'minor' })]);
      vi.spyOn(core, 'getReportEvidence').mockResolvedValue({ authorId: 'u-2', channelId: 'c-general', ts: 1, text: 'the content' });
    });
    const panel = await openReports();
    const item = await within(panel).findByRole('listitem');
    expect(within(item).getByText(/105 hotline/)).toBeTruthy();
    const actions = item.querySelector('.report-actions')!;
    expect(actions.querySelector('button')?.textContent).toBe('Delete the message');
    await click(within(item).getByRole('button', { name: 'Show content' }));
    await click(within(item).getByRole('button', { name: 'Show' }));
    const quote = await waitFor(() => item.querySelector('blockquote.report-evidence')!);
    expect(quote.classList.contains('no-copy')).toBe(true);
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    quote.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
  });

  it('"Mark as handled" dismisses it on this device', async () => {
    const { core } = await setup();
    const dismiss = vi.spyOn(core, 'dismissReport');
    const panel = await openReports();
    const first = (await within(panel).findAllByRole('listitem'))[0]!;
    await click(within(first).getByRole('button', { name: 'Mark as handled' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(panel).getAllByText('Handled').length).toBe(1));
  });
});

describe('G-48: help lines', () => {
  it('self-harm: the 101 / ERAN line in the dialog and on the Reports page (PO, UX)', async () => {
    await setup((core) => {
      vi.spyOn(core, 'listReports').mockResolvedValue([summary({ reason: 'self-harm' })]);
    });
    const dialog = await reportFirstOthersMessage();
    const line = /call 101 \(Magen David Adom\)\. For emotional support, you can call ERAN at 1201\./;
    expect(within(dialog).queryByText(line)).toBeNull();
    await click(within(dialog).getByRole('radio', { name: 'Self-harm' }));
    expect(within(dialog).getByText(line).closest('[role="note"]')).toBeTruthy();
    // No tel: links.
    expect(dialog.querySelector('a[href^="tel:"]')).toBeNull();
    await click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const panel = await openReports();
    const item = await within(panel).findByRole('listitem');
    expect(within(item).getByText(line)).toBeTruthy();
  });

  it("reason 6: the build's abuse address beside the 105 line, only when it's a plain address", async () => {
    await setup((core) => {
      vi.spyOn(core, 'getAppInfo').mockResolvedValue({ version: '1', updateChannel: 'stable', abuseAddress: 'abuse@example.org' } as never);
    });
    const dialog = await reportFirstOthersMessage();
    await click(within(dialog).getByRole('radio', { name: 'Involves a minor' }));
    expect(await within(dialog).findByText('abuse@example.org')).toBeTruthy();
    expect(within(dialog).getByText('You can also contact the MVS team:')).toBeTruthy();
  });

  it('no address in the build (or a bad one): the 105 line alone', async () => {
    await setup((core) => {
      vi.spyOn(core, 'getAppInfo').mockResolvedValue({ version: '1', updateChannel: 'stable', abuseAddress: 'javascript:alert(1)' } as never);
    });
    const dialog = await reportFirstOthersMessage();
    await click(within(dialog).getByRole('radio', { name: 'Involves a minor' }));
    await act(async () => {});
    expect(within(dialog).getByText(/105 hotline/)).toBeTruthy();
    expect(within(dialog).queryByText('You can also contact the MVS team:')).toBeNull();
  });

  it('cleanAbuseAddress: e-mail or https only', async () => {
    const { cleanAbuseAddress } = await import('../app/abuseAddress');
    expect(cleanAbuseAddress('abuse@example.org')).toBe('abuse@example.org');
    expect(cleanAbuseAddress('https://example.org/report')).toBe('https://example.org/report');
    expect(cleanAbuseAddress('http://example.org')).toBe('');
    expect(cleanAbuseAddress('javascript:alert(1)')).toBe('');
    expect(cleanAbuseAddress('https://user:pw@example.org')).toBe('');
    expect(cleanAbuseAddress('a b@example.org')).toBe('');
    expect(cleanAbuseAddress(undefined)).toBe('');
  });
});
