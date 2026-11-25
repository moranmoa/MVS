// B24a (docs/ux/specs/B24-about.md §1, split by the manager): Settings → About
// gets "Copy version details" and "Report abuse or illegal content". The
// address comes from the build (getAppInfo.abuseAddress, #552) and is shown as
// text with Copy: never opened as mailto: (security lead on #552). Without one
// (dev, demo) the pending line shows and there is no Copy button.

import { FormattedMessage, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { cleanAbuseAddress } from '../../app/abuseAddress';
import { copyText } from '../../app/clipboard';
import type { AppInfo } from '../../core';
import './about.css';

/** What "Copy version details" copies: for bug reports. */
export function versionDetails(version: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return platform ? `MVS ${version} (${platform})` : `MVS ${version}`;
}

export function CopyVersionButton({ version }: { version: string }) {
  const store = useAppStore();
  return (
    <button
      type="button"
      className="link small"
      onClick={async () => store.showFlash((await copyText(versionDetails(version))) ? 'common.copied' : 'menu.copyFailed')}
    >
      <FormattedMessage id="about.copyVersion" />
    </button>
  );
}

export function AbuseReportSection({ info }: { info: AppInfo }) {
  const store = useAppStore();
  const intl = useIntl();
  const address = cleanAbuseAddress(info.abuseAddress);
  return (
    <section className="stack-tight about-report" aria-labelledby="about-report-h">
      <h4 id="about-report-h">
        <FormattedMessage id="about.report" />
      </h4>
      <p className="small">
        <FormattedMessage id="about.report.body" />
      </p>
      {address ? (
        <div className="about-address">
          <bdi dir="ltr" className="about-address-text">
            {address}
          </bdi>
          <button
            type="button"
            className="secondary small"
            aria-label={`${intl.formatMessage({ id: 'common.copy' })}: ${address}`}
            onClick={async () => store.showFlash((await copyText(address)) ? 'common.copied' : 'menu.copyFailed')}
          >
            <FormattedMessage id="common.copy" />
          </button>
        </div>
      ) : (
        <p className="muted small">
          <FormattedMessage id="about.report.pending" />
        </p>
      )}
    </section>
  );
}
