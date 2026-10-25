export interface ImpressionReport {
  post_id: string;
  position: number;
  duration_ms: number;
}

export interface ImpressionTrackerOptions {
  /** A post counts as seen once at least this much of it was visible. Default 0.5. */
  visibleRatio?: number;
  /** Shorter views are fly-bys and are not reported. Default 1000 ms. */
  minViewMs?: number;
  /** How often queued reports are sent. Default 5000 ms. */
  flushIntervalMs?: number;
  /** Send immediately once this many reports are queued. Default 10. */
  maxBatch?: number;
  now?: () => number;
}

type Send = (batch: ImpressionReport[]) => void | Promise<void>;

/**
 * Measures how long each post is actually on screen and reports it to /api/impressions. This is what
 * lets the ranking learn from viewing (a 3 s+ view strengthens the post's topics) and stop
 * re-serving posts the viewer already saw.
 */
export class ImpressionTracker {
  private readonly send: Send;
  private readonly minViewMs: number;
  private readonly maxBatch: number;
  private readonly now: () => number;
  private readonly observer: IntersectionObserver | null;
  private readonly targets = new Map<Element, { postId: string; position: number; since: number | null }>();
  private queue: ImpressionReport[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onHidden = () => {
    if (document.visibilityState === 'hidden') this.flush();
  };

  constructor(send: Send, options: ImpressionTrackerOptions = {}) {
    this.send = send;
    this.minViewMs = options.minViewMs ?? 1000;
    this.maxBatch = options.maxBatch ?? 10;
    this.now = options.now ?? (() => Date.now());
    this.observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => entries.forEach((e) => this.onEntry(e)), {
            threshold: options.visibleRatio ?? 0.5,
          });
    if (this.observer) {
      this.timer = setInterval(() => this.flush(), options.flushIntervalMs ?? 5000);
      document.addEventListener('visibilitychange', this.onHidden);
    }
  }

  /** Start measuring an element. Returns a function that stops measuring and records what was seen. */
  observe(el: Element, postId: string, position: number): () => void {
    if (!this.observer) return () => undefined;
    this.targets.set(el, { postId, position, since: null });
    this.observer.observe(el);
    return () => {
      this.endView(el);
      this.observer?.unobserve(el);
      this.targets.delete(el);
    };
  }

  /** Send everything queued, including views still in progress. */
  flush(): void {
    for (const el of this.targets.keys()) {
      const target = this.targets.get(el);
      if (target?.since != null) {
        this.endView(el);
        target.since = this.now(); // still on screen: keep measuring from here
      }
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    void Promise.resolve(this.send(batch)).catch(() => undefined); // best effort, never break the feed
  }

  dispose(): void {
    for (const el of [...this.targets.keys()]) this.endView(el);
    this.flush();
    this.observer?.disconnect();
    this.targets.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.observer) document.removeEventListener('visibilitychange', this.onHidden);
  }

  private onEntry(entry: IntersectionObserverEntry): void {
    const target = this.targets.get(entry.target);
    if (!target) return;
    if (entry.isIntersecting) {
      if (target.since == null) target.since = this.now();
    } else {
      this.endView(entry.target);
      if (this.queue.length >= this.maxBatch) this.flush();
    }
  }

  private endView(el: Element): void {
    const target = this.targets.get(el);
    if (!target || target.since == null) return;
    const duration = this.now() - target.since;
    target.since = null;
    if (duration >= this.minViewMs) {
      this.queue.push({ post_id: target.postId, position: target.position, duration_ms: Math.round(duration) });
    }
  }
}

/** Default sender: fire-and-forget POST that survives the page closing. */
export function sendImpressions(batch: ImpressionReport[]): Promise<void> {
  return fetch('/api/impressions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impressions: batch }),
    keepalive: true,
  }).then(() => undefined);
}
