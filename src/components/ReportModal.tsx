import React, { useState } from 'react';
import { X } from 'lucide-react';

interface ReportModalProps {
  targetType: 'post' | 'comment' | 'user';
  targetId: string;
  onClose: () => void;
  onReportSubmitted: () => void;
}

export const ReportModal: React.FC<ReportModalProps> = ({
  targetType,
  targetId,
  onClose,
  onReportSubmitted,
}) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type: targetType,
          target_id: targetId,
          reason: reason.trim(),
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to submit report');
      }

      onReportSubmitted();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#17233A]/40 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-sm p-4 max-w-[420px] w-full space-y-4 shadow-sheet">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <span className="text-[15px] font-semibold text-text">Report {targetType}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-text-muted hover:text-text cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="p-2.5 rounded-sm bg-danger-tint text-danger text-[13px]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="report-reason" className="block text-[13px] font-medium text-text mb-1">
              Reason
            </label>
            <textarea
              id="report-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you reporting this content?"
              maxLength={500}
              required
              className="w-full bg-bg border border-border rounded-sm p-2.5 text-[15px] text-text focus:outline-none focus:border-primary resize-none transition-colors"
            />
          </div>

          <div className="flex justify-end space-x-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-3 text-[14px] font-medium text-text-muted hover:text-text cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !reason.trim()}
              className="min-h-[44px] px-4 rounded-sm bg-danger hover:bg-danger/90 disabled:opacity-50 text-on-primary font-semibold text-[14px] cursor-pointer transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
