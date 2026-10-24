import qrcode from 'qrcode-generator';

/** A QR code drawn as one SVG path (no innerHTML). Encodes exactly `value`, so pass only a public address. */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // the standard four-module quiet zone
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const full = n + quiet * 2;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${full} ${full}`} width={size} height={size} shapeRendering="crispEdges" className="block rounded-[8px]">
      <rect width={full} height={full} fill="#FFFFFF" />
      <path d={d} fill="#17233A" />
    </svg>
  );
}
