// G-81 B: whether calls over the P2P network are on in this build. The
// desktop shell puts `voiceP2p: true` on core.status (desktop/src/config.js
// voiceP2pFor); anything else is off. One flag for everything B ships with:
// the media path, the C2 switch and the notice v3 (TL A8, SL B6).

import { useEffect, useState } from 'react';
import { useCore } from '../core';

export function useVoiceP2p(): boolean {
  const core = useCore();
  const [on, setOn] = useState(false);
  useEffect(() => core.on('core.status', (s) => setOn(s.voiceP2p === true)), [core]);
  return on;
}
