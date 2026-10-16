import React from 'react';

interface ExpiryChipProps {
  expiresAt: string;
}

export const ExpiryChip: React.FC<ExpiryChipProps> = ({ expiresAt }) => {
  const remainingMs = new Date(expiresAt).getTime() - Date.now();

  if (remainingMs <= 0) {
    return <span className="text-[12px] text-[var(--danger,#B23A40)] font-semibold">0d left</span>;
  }

  const hoursRemaining = remainingMs / (1000 * 60 * 60);

  // Red under 24h
  if (hoursRemaining < 24) {
    const text = hoursRemaining < 1
      ? `${Math.max(1, Math.floor(remainingMs / (1000 * 60)))}m left`
      : `${Math.floor(hoursRemaining)}h left`;
    return <span className="text-[12px] text-[var(--danger,#B23A40)] font-semibold">{text}</span>;
  }

  // Yellow-brown and bold under 48h
  if (hoursRemaining < 48) {
    const days = Math.ceil(hoursRemaining / 24);
    return (
      <span className="text-[12px] text-[var(--accent-text,#8A6A00)] font-semibold">
        {days}d left
      </span>
    );
  }

  // Muted normally (e.g. "6d left")
  const days = Math.ceil(hoursRemaining / 24);
  return (
    <span className="text-[12px] text-[var(--muted,#5B6577)] font-normal">
      {days}d left
    </span>
  );
};
