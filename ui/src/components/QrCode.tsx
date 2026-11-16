// A QR code drawn as SVG squares from qrcode-generator's module grid: no
// markup strings, no data: URL, nothing that CSP or the sanitizer must allow.

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ text, label, size = 200 }: { text: string; label: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push(`M${c} ${r}h1v1h-1z`);
    return { n, d: dark.join('') };
  }, [text]);
  // A 4-module quiet zone, as scanners expect.
  const box = cells.n + 8;
  return (
    <svg className="qr-code" role="img" aria-label={label} width={size} height={size} viewBox={`-4 -4 ${box} ${box}`} shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={box} height={box} fill="#fff" />
      <path d={cells.d} fill="#000" />
    </svg>
  );
}
