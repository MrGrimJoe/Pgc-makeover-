export interface EmbeddingProvider {
  generateEmbedding(text: string): Promise<number[] | null>;
}

/**
 * Default null embedding provider (semantic embeddings can be plugged in later).
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  async generateEmbedding(_text: string): Promise<number[] | null> {
    return null;
  }
}

export interface ExtractedTopic {
  slug: string;
  displayName: string;
  confidence: number;
}

const KEYWORD_MAP: Record<string, string> = {
  tech: 'Technology',
  code: 'Technology',
  software: 'Technology',
  ai: 'Artificial Intelligence',
  campus: 'Campus Life',
  housing: 'Housing',
  dorm: 'Housing',
  apartment: 'Housing',
  food: 'Food & Dining',
  dining: 'Food & Dining',
  coffee: 'Food & Dining',
  sports: 'Sports & Fitness',
  gym: 'Sports & Fitness',
  fitness: 'Sports & Fitness',
  music: 'Music & Arts',
  art: 'Music & Arts',
  concert: 'Music & Arts',
  events: 'Events & Parties',
  party: 'Events & Parties',
  careers: 'Career & Jobs',
  job: 'Career & Jobs',
  internship: 'Career & Jobs',
  classes: 'Academics',
  homework: 'Academics',
  exam: 'Academics',
  study: 'Academics',
  library: 'Academics',
  design: 'Design',
  fashion: 'Fashion',
};

/**
 * Extracts hashtags and keyword topics from post text with simple term weighting.
 * Code-only, zero external AI service calls.
 */
export function extractTopicsFromText(text: string): ExtractedTopic[] {
  const topics: ExtractedTopic[] = [];
  const seenSlugs = new Set<string>();

  // 1. Extract #hashtags (max 5)
  const hashtagRegex = /#([a-zA-Z0-9_]{1,30})/g;
  let match: RegExpExecArray | null;

  while ((match = hashtagRegex.exec(text)) !== null) {
    const rawTag = match[1]!;
    const slug = rawTag.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (slug && !seenSlugs.has(slug)) {
      seenSlugs.add(slug);
      topics.push({
        slug,
        displayName: `#${rawTag}`,
        confidence: 1.0,
      });
      if (topics.length >= 5) break;
    }
  }

  // 2. Keyword topics if under limit of 5
  if (topics.length < 5) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/);

    for (const w of words) {
      if (KEYWORD_MAP[w]) {
        const slug = w;
        if (!seenSlugs.has(slug)) {
          seenSlugs.add(slug);
          topics.push({
            slug,
            displayName: KEYWORD_MAP[w]!,
            confidence: 0.8,
          });
          if (topics.length >= 5) break;
        }
      }
    }
  }

  return topics;
}
