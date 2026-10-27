import React, { useState } from 'react';
import { ImageEditor } from './ImageEditor.tsx';
import { EditedResult } from './EditedResult.tsx';
import type { MediaEnv } from '../lib/media.ts';

interface EditFlowProps {
  /** The still picture to put text on. */
  source: Blob;
  onClose: () => void;
  /** When set, the finished picture can be sent (for example into the open chat). */
  onSend?: (file: File) => void;
  sendLabel?: string;
  env?: MediaEnv;
}

/** Editor first, then what to do with the result. "Edit again" adds more text on top of the result. */
export const EditFlow: React.FC<EditFlowProps> = ({ source, onClose, onSend, sendLabel, env }) => {
  const [current, setCurrent] = useState<Blob>(source);
  const [result, setResult] = useState<File | null>(null);

  if (result) {
    return <EditedResult file={result} onClose={onClose} onEditAgain={() => { setCurrent(result); setResult(null); }} onSend={onSend} sendLabel={sendLabel} />;
  }
  return <ImageEditor source={current} doneLabel="Done" onCancel={onClose} onDone={({ file }) => setResult(file)} env={env} />;
};
