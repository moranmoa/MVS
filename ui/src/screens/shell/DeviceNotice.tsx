// "A new device was added to your account" (device link follow-up): on my
// other devices, with the device and the time. "It was me" acknowledges it;
// "It wasn't me" explains what to do. It stays until answered.

import { useState } from 'react';
import { FormattedDate, FormattedMessage, FormattedTime, useIntl } from 'react-intl';
import { useAppStore } from '../../app/App';
import { useStore } from '../../app/store';
import { Dialog } from '../../components/common';
import { ShieldIcon } from '../../components/icons';

export function DeviceNotices() {
  const store = useAppStore();
  const intl = useIntl();
  const notices = useStore(store, (s) => s.deviceNotices);
  const [help, setHelp] = useState(false);
  return (
    <>
      {notices.length > 0 && (
        <div className="device-notices">
      {notices.map((d) => (
        <div key={d.at} className="toast device-notice" role="alert">
          <ShieldIcon />
          <div className="device-notice-body">
            <strong>
              <FormattedMessage id="deviceNotice.title" />
            </strong>
            <span>
              {d.label ? <FormattedMessage id="deviceNotice.label" values={{ label: <bdi className="user-text">“{d.label}”</bdi> }} /> : <FormattedMessage id="deviceNotice.unknown" />}
              {' · '}
              <FormattedDate value={d.at} day="numeric" month="short" /> <FormattedTime value={d.at} />
            </span>
            <div className="actions">
              <button type="button" className="secondary small device-notice-me" onClick={() => store.dismissDeviceNotice(d.at)}>
                <FormattedMessage id="deviceNotice.me" />
              </button>
              <button type="button" className="danger small" onClick={() => setHelp(true)}>
                <FormattedMessage id="deviceNotice.notMe" />
              </button>
            </div>
          </div>
        </div>
      ))}
        </div>
      )}
      <Dialog open={help} onClose={() => setHelp(false)} title={intl.formatMessage({ id: 'deviceNotice.help.title' })} className="device-notice-help">
        <p>
          <FormattedMessage id="deviceNotice.help.intro" />
        </p>
        <ol>
          <li>
            <FormattedMessage id="deviceNotice.help.step1" />
          </li>
          <li>
            <FormattedMessage id="deviceNotice.help.step2" />
          </li>
          <li>
            <FormattedMessage id="deviceNotice.help.step3" />
          </li>
        </ol>
        <p className="muted small">
          <FormattedMessage id="deviceNotice.help.later" />
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setHelp(false)}>
            <FormattedMessage id="common.close" />
          </button>
        </div>
      </Dialog>
    </>
  );
}
