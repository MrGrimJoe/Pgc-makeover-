import React from 'react';

/** A library sticker or GIF in the picker grid. Reduced motion shows animated files too, because they are small and chosen by the person. */
export const LibraryImage: React.FC<{ mediaId: string; kind: 'sticker' | 'gif' }> = ({ mediaId, kind }) => (
  <img src={`/api/media/${encodeURIComponent(mediaId)}`} alt={kind === 'sticker' ? 'Sticker' : 'GIF'} loading="lazy" className="w-full h-full object-contain" />
);
