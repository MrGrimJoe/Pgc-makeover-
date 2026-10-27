import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useFocusTrap } from '../lib/focus-trap.ts';
import { browserMediaEnv, type Canvas2DLike, type MediaEnv } from '../lib/media.ts';
import {
  MAX_LAYERS, MAX_TEXT_LENGTH, SIZE_MAX, SIZE_MIN, TEXT_COLORS,
  createLayer, createMemeLayers, drawLayers, editedFileName, hasAnyText, hasText, hitTest, layoutLayer, normalizeLayer, renderEdited,
  type TextLayer,
} from '../lib/image-edit.ts';

export interface EditedImage {
  file: File;
  width: number;
  height: number;
  thumb: Blob | null;
}

interface ImageEditorProps {
  /** The picture to put text on. A still image; animated files are flattened to their first frame. */
  source: Blob;
  title?: string;
  /** Label of the main button, for example "Use this picture". */
  doneLabel?: string;
  onCancel: () => void;
  /** Called with the finished picture. Throw to show an error and stay open. */
  onDone: (result: EditedImage) => Promise<void> | void;
  /** Injected in tests; the browser's canvas is used otherwise. */
  env?: MediaEnv;
}

/** Longest edge of the on-screen canvas. The saved picture is drawn again at its own size, so this only affects speed. */
const PREVIEW_EDGE = 960;

const chip = (on: boolean) =>
  `min-h-[44px] px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${
    on ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] border-[var(--blue,#244C8A)]' : 'bg-[var(--bg,#fff)] text-[var(--text,#17233A)] border-[var(--line,#E8EBF0)]'
  }`;

const layerLabel = (i: number): string => (i === 0 ? 'Top text' : i === 1 ? 'Bottom text' : `Text ${i + 1}`);

/**
 * Full-screen editor for putting text on a picture (memes). Drag a caption on the picture, or use the sliders, which
 * work with the keyboard and a screen reader. The result is drawn again at full size on Done, so the text stays sharp.
 */
export const ImageEditor: React.FC<ImageEditorProps> = ({ source, title = 'Add text', doneLabel = 'Done', onCancel, onDone, env }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<TextLayer[]>(() => createMemeLayers());
  const [selectedId, setSelectedId] = useState<string>(() => layers[0]!.id);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  useFocusTrap(rootRef, () => !busy && onCancel());

  // Load the picture once
  useEffect(() => {
    let cancelled = false;
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(source) : '';
    const el = new Image();
    el.onload = () => { if (!cancelled) setImg(el); };
    el.onerror = () => { if (!cancelled) setLoadError(true); };
    el.src = url;
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL?.(url);
    };
  }, [source]);

  const preview = useMemo(() => {
    if (!img || !img.naturalWidth) return null;
    const k = Math.min(1, PREVIEW_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    return { w: Math.max(1, Math.round(img.naturalWidth * k)), h: Math.max(1, Math.round(img.naturalHeight * k)) };
  }, [img]);

  const selected = layers.find((l) => l.id === selectedId) ?? layers[0]!;

  const context = (): CanvasRenderingContext2D | null => {
    try {
      return canvasRef.current?.getContext('2d') ?? null;
    } catch {
      return null; // no canvas support (tests)
    }
  };

  // Redraw the preview whenever the picture or a caption changes
  useEffect(() => {
    const ctx = context();
    if (!ctx || !img || !preview) return;
    ctx.clearRect(0, 0, preview.w, preview.h);
    ctx.drawImage(img, 0, 0, preview.w, preview.h);
    drawLayers(ctx as unknown as Canvas2DLike, layers, preview.w, preview.h);
    // The frame around the selected caption is a guide only; it is not part of the saved picture
    const sel = layers.find((l) => l.id === selectedId);
    if (sel) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#FFFFFF';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 3;
      if (hasText(sel)) {
        const b = layoutLayer(sel, preview.w, preview.h, ctx as unknown as Canvas2DLike);
        ctx.strokeRect(b.left - 6, b.top - 4, b.width + 12, b.height + 8);
      } else {
        const w = preview.w * 0.5;
        const h = sel.size * preview.w * 1.12;
        const cx = Math.min(Math.max(sel.x * preview.w, w / 2), preview.w - w / 2);
        const cy = Math.min(Math.max(sel.y * preview.h, h / 2), preview.h - h / 2);
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      }
      ctx.restore();
    }
  }, [img, preview, layers, selectedId]);

  const patch = (changes: Partial<TextLayer>) => setLayers((all) => all.map((l) => (l.id === selected.id ? normalizeLayer({ ...l, ...changes }) : l)));

  const pointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { fx: (e.clientX - rect.left) / (rect.width || 1), fy: (e.clientY - rect.top) / (rect.height || 1) };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = context();
    if (!ctx || !preview) return;
    const { fx, fy } = pointer(e);
    const id = hitTest(layers, fx, fy, preview.w, preview.h, ctx as unknown as Canvas2DLike);
    if (!id) return;
    const layer = layers.find((l) => l.id === id)!;
    setSelectedId(id);
    drag.current = { id, dx: layer.x - fx, dy: layer.y - fy };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const { fx, fy } = pointer(e);
    setLayers((all) => all.map((l) => (l.id === d.id ? normalizeLayer({ ...l, x: fx + d.dx, y: fy + d.dy }) : l)));
  };
  const onUp = () => { drag.current = null; };

  const add = () => {
    if (layers.length >= MAX_LAYERS) return;
    const layer = createLayer({ y: 0.5 });
    setLayers((all) => [...all, layer]);
    setSelectedId(layer.id);
  };
  const remove = () => {
    if (layers.length <= 1) return;
    const i = layers.findIndex((l) => l.id === selected.id);
    const next = layers.filter((l) => l.id !== selected.id);
    setLayers(next);
    setSelectedId(next[Math.max(0, i - 1)]!.id);
  };

  const done = async () => {
    if (busy) return;
    if (!hasAnyText(layers)) {
      setError('Type some text first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await renderEdited(source, layers, env ?? browserMediaEnv());
      await onDone({ file: new File([out.blob], editedFileName(out.mime), { type: out.mime }), width: out.width, height: out.height, thumb: out.thumb });
    } catch (e) {
      setError((e as Error).message || 'Could not save the picture.');
      setBusy(false);
    }
  };

  const slider = 'w-full min-h-[44px]';
  const labelCls = 'text-[12px] text-[var(--muted,#5B6577)] block';

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="fixed inset-0 left-[var(--nav-w,0px)] z-[60] bg-[var(--bg,#fff)] flex flex-col max-w-content mx-auto">
      <header className="h-[48px] flex items-center justify-between px-2 border-b border-[var(--line,#E8EBF0)] shrink-0">
        <div className="flex items-center">
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Cancel editing" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-[var(--text,#17233A)] cursor-pointer disabled:opacity-40">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
          <h2 className="m-0 text-[16px] font-semibold text-[var(--text,#17233A)]">{title}</h2>
        </div>
        <button type="button" onClick={() => void done()} disabled={busy || loadError} className="min-h-[44px] px-4 rounded-full bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[14px] font-semibold cursor-pointer border-0 disabled:opacity-40">
          {busy ? 'Working...' : doneLabel}
        </button>
      </header>

      <div className="flex-1 min-h-0 flex items-center justify-center bg-[var(--bg2,#F8F9FC)] p-2 overflow-hidden" data-testid="editor-stage">
        {loadError ? (
          <p role="alert" className="m-0 text-[14px] text-[var(--danger,#B23A40)]">This picture could not be opened.</p>
        ) : !preview ? (
          <p className="m-0 text-[14px] text-[var(--muted,#5B6577)]" aria-busy="true">Loading...</p>
        ) : (
          <canvas
            ref={canvasRef}
            width={preview.w}
            height={preview.h}
            role="img"
            aria-label="Picture with your text. Drag a caption to move it, or use the sliders below."
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{ aspectRatio: `${preview.w} / ${preview.h}`, touchAction: 'none' }}
            className="max-w-full max-h-full rounded-[8px] bg-[var(--bg,#fff)]"
          />
        )}
      </div>

      <div className="shrink-0 max-h-[46%] overflow-y-auto border-t border-[var(--line,#E8EBF0)] p-3 space-y-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Text boxes" className="flex gap-2 overflow-x-auto flex-1">
            {layers.map((l, i) => (
              <button key={l.id} type="button" role="radio" aria-checked={l.id === selected.id} onClick={() => setSelectedId(l.id)} className={`shrink-0 ${chip(l.id === selected.id)}`}>
                {layerLabel(i)}
              </button>
            ))}
          </div>
          <button type="button" onClick={add} disabled={layers.length >= MAX_LAYERS} aria-label="Add a text box" className="shrink-0 min-h-[44px] min-w-[44px] rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] cursor-pointer inline-flex items-center justify-center disabled:opacity-40">
            <Plus className="w-4 h-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={remove} disabled={layers.length <= 1} aria-label={`Delete ${layerLabel(layers.findIndex((l) => l.id === selected.id))}`} className="shrink-0 min-h-[44px] min-w-[44px] rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--danger,#B23A40)] cursor-pointer inline-flex items-center justify-center disabled:opacity-40">
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div>
          <label htmlFor="editor-text" className="block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Text</label>
          <textarea
            id="editor-text"
            value={selected.text}
            rows={2}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={layers[0] && selected.id === layers[0].id ? 'Top text' : 'Type here'}
            onChange={(e) => patch({ text: e.target.value })}
            className="w-full bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[12px] px-3.5 py-2.5 text-[15px] text-[var(--text,#17233A)] outline-none resize-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className={labelCls}>
            Size
            <input type="range" min={Math.round(SIZE_MIN * 100)} max={Math.round(SIZE_MAX * 100)} value={Math.round(selected.size * 100)} onChange={(e) => patch({ size: Number(e.target.value) / 100 })} className={slider} />
          </label>
          <label className={labelCls}>
            Across
            <input type="range" min={0} max={100} value={Math.round(selected.x * 100)} onChange={(e) => patch({ x: Number(e.target.value) / 100 })} className={slider} />
          </label>
          <label className={labelCls}>
            Up and down
            <input type="range" min={0} max={100} value={Math.round(selected.y * 100)} onChange={(e) => patch({ y: Number(e.target.value) / 100 })} className={slider} />
          </label>
        </div>

        <div role="radiogroup" aria-label="Text colour" className="flex flex-wrap gap-2">
          {TEXT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={selected.color.toLowerCase() === c.value.toLowerCase()}
              aria-label={c.label}
              onClick={() => patch({ color: c.value })}
              style={{ background: c.value }}
              className={`w-[44px] h-[44px] rounded-full cursor-pointer ${selected.color.toLowerCase() === c.value.toLowerCase() ? 'border-[3px] border-[var(--blue,#244C8A)]' : 'border border-[var(--line,#E8EBF0)]'}`}
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={selected.outline} onClick={() => patch({ outline: !selected.outline })} className={chip(selected.outline)}>Outline</button>
          <button type="button" aria-pressed={selected.uppercase} onClick={() => patch({ uppercase: !selected.uppercase })} className={chip(selected.uppercase)}>ALL CAPS</button>
          <div role="radiogroup" aria-label="Letter style" className="flex gap-2">
            <button type="button" role="radio" aria-checked={selected.style === 'meme'} onClick={() => patch({ style: 'meme' })} className={chip(selected.style === 'meme')}>Meme</button>
            <button type="button" role="radio" aria-checked={selected.style === 'plain'} onClick={() => patch({ style: 'plain' })} className={chip(selected.style === 'plain')}>Plain</button>
          </div>
        </div>

        {error && <div role="alert" className="p-2.5 rounded-[8px] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">{error}</div>}
      </div>
    </div>
  );
};
