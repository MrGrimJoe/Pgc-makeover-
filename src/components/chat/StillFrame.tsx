import React, { useEffect, useRef, useState } from 'react';

interface StillFrameProps {
  src: string;
  alt: string;
  className?: string;
}

/**
 * The first frame of a picture, drawn once and never animated. Used where motion is reduced: the person still sees
 * what each GIF is, and nothing moves until they ask. If the frame cannot be drawn the browser's own <img> is the
 * fallback (it may animate, which is better than showing nothing).
 */
export const StillFrame: React.FC<StillFrameProps> = ({ src, alt, className = '' }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFallback(false);
    const img = new Image();
    img.onload = () => {
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      if (cancelled || !c || !ctx || !img.naturalWidth) { if (!cancelled) setFallback(true); return; }
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
    };
    img.onerror = () => { if (!cancelled) setFallback(true); };
    img.src = src;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [src]);

  if (fallback) return <img src={src} alt={alt} className={className} />;
  return <canvas ref={canvas} role="img" aria-label={alt} className={className} />;
};
