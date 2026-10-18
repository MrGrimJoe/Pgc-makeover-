// DEV-ONLY: remove before launch
import path from 'path';
import { fileURLToPath } from 'url';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { normalizeUsername } from '../shared/username.ts';


export interface SeedUser {
  id: string;
  username: string;
  display_name: string;
  class_id: string;
  bio: string;
}

export const SEEDED_USERS: SeedUser[] = [
  { id: 'usr_alice', username: 'alice', display_name: 'Alice Adams', class_id: 'cls_2025', bio: 'Senior majoring in CS & Ethics.' },
  { id: 'usr_bob', username: 'bob', display_name: 'Bob Builder', class_id: 'cls_2026', bio: 'Junior building robotics & open-source tools.' },
  { id: 'usr_charlie', username: 'charlie', display_name: 'Charlie Chen', class_id: 'cls_2027', bio: 'Sophomore design enthusiast and photographer.' },
  { id: 'usr_dave', username: 'dave', display_name: 'Dave Davis', class_id: 'cls_2028', bio: 'Freshman curious about distributed systems.' },
  { id: 'usr_emma', username: 'emma', display_name: 'Emma Watson', class_id: 'cls_alumni', bio: 'Class of 2023 | Software engineer at tech startup.' },
  { id: 'usr_fiona', username: 'fiona', display_name: 'Prof. Fiona Gallagher', class_id: 'cls_faculty', bio: 'Faculty advisor in Computer Science & HCI.' },
  { id: 'usr_george', username: 'george', display_name: 'George Miller', class_id: 'cls_2025', bio: 'Organizing campus hackathons and tech talks.' },
  { id: 'usr_hannah', username: 'hannah', display_name: 'Hannah Abbott', class_id: 'cls_2026', bio: 'Junior studying biology and data science.' },
  { id: 'usr_ian', username: 'ian', display_name: 'Ian Malcolm', class_id: 'cls_2027', bio: 'Math, chaos theory, and campus coffee runs.' },
  { id: 'usr_julia', username: 'julia', display_name: 'Julia Roberts', class_id: 'cls_2028', bio: 'Freshman exploring campus clubs and events.' },
  { id: 'usr_kevin', username: 'kevin', display_name: 'Kevin Hart', class_id: 'cls_alumni', bio: 'Alumni mentor and campus newsletter editor.' },
  { id: 'usr_laura', username: 'laura', display_name: 'Dr. Laura Croft', class_id: 'cls_faculty', bio: 'Digital archives researcher and guest lecturer.' },
];

export async function seedDevDatabase(targetDbPath?: string, envOverride?: string) {
  // Check ENVIRONMENT
  const env = envOverride || process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';
  if (env === 'production') {
    throw new Error('Refusing to seed: ENVIRONMENT cannot be production');
  }

  const dbPath = targetDbPath || path.resolve(process.cwd(), '.local-dev-d1.sqlite');
  const baseName = path.basename(dbPath);

  // Must refuse to run unless the target is the local dev DB (.local-dev-d1.sqlite only, never anything remote)
  if (baseName !== '.local-dev-d1.sqlite') {
    throw new Error(`Refusing to seed: target must be .local-dev-d1.sqlite only, got ${baseName}`);
  }

  const d1 = createSqliteD1(dbPath);

  // Ensure migrations are up to date including messaging tables
  await runMigrations(d1, ALL_MIGRATIONS);

  // Safe to re-run: Clear previously seeded rows
  const userIds = SEEDED_USERS.map((u) => u.id);
  const ph = userIds.map(() => '?').join(',');

  // Clear in reverse dependency order
  await d1.prepare(`DELETE FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE sender_id IN (${ph}))`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM messages WHERE sender_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM conversation_members WHERE user_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM conversations WHERE id LIKE 'conv_seed_%'`).run();
  await d1.prepare(`DELETE FROM blocks WHERE blocker_id IN (${ph}) OR blocked_id IN (${ph})`).bind(...userIds, ...userIds).run();
  await d1.prepare(`DELETE FROM post_reactions WHERE user_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM comments WHERE author_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM follows WHERE follower_id IN (${ph}) OR followed_id IN (${ph})`).bind(...userIds, ...userIds).run();
  await d1.prepare(`DELETE FROM post_topics WHERE post_id IN (SELECT id FROM posts WHERE author_id IN (${ph}))`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM posts WHERE author_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM sessions WHERE user_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM user_settings WHERE user_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM profiles WHERE user_id IN (${ph})`).bind(...userIds).run();
  await d1.prepare(`DELETE FROM users WHERE id IN (${ph})`).bind(...userIds).run();

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const sessionExpiry = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Insert 12 Users, Profiles, Settings, and Sessions
  for (const u of SEEDED_USERS) {
    await d1.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
      .bind(u.id, `mock-google-sub-${u.username}`, nowIso, 'active')
      .run();

    await d1.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(u.id, u.username, normalizeUsername(u.username), u.display_name, u.bio, u.class_id)
      .run();

    await d1.prepare('INSERT INTO user_settings (user_id, dm_policy, feed_preferences) VALUES (?, ?, ?)')
      .bind(u.id, 'everyone', '{}')
      .run();

    // Create session for each seeded user
    await d1.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`sess_${u.username}`, u.id, sessionExpiry)
      .run();
  }

  // Topics
  const topicList = [
    { id: 'top_campus', slug: 'campus', display_name: 'Campus Life' },
    { id: 'top_tech', slug: 'technology', display_name: 'Technology' },
    { id: 'top_study', slug: 'study', display_name: 'Study Sessions' },
    { id: 'top_events', slug: 'events', display_name: 'Events' },
    { id: 'top_sports', slug: 'sports', display_name: 'Sports' },
    { id: 'top_food', slug: 'food', display_name: 'Campus Dining' },
    { id: 'top_research', slug: 'research', display_name: 'Research' },
    { id: 'top_alumni', slug: 'alumni', display_name: 'Alumni Network' },
    { id: 'top_hackathon', slug: 'hackathon', display_name: 'Hackathons' },
    { id: 'top_design', slug: 'design', display_name: 'Design' },
  ];

  for (const t of topicList) {
    await d1.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)')
      .bind(t.id, t.slug, t.display_name)
      .run();
  }

  // 2. Insert 30 Posts spread across ages from 1 hour to 6 days old
  // Under 24h from expiry (age 6d 1h to 6d 23h): indices 24 to 29
  // Under 48h from expiry (age 5d 2h to 5d 20h): indices 20 to 23
  // 48h+ from expiry: indices 0 to 19
  const postSpecs = [
    { author: 'alice', body: 'Excited for the upcoming campus hackathon! Who wants to team up? #hackathon #technology', ageHours: 1 },
    { author: 'bob', body: 'Just pushed a new open source library for distributed consensus! #technology #research', ageHours: 3 },
    { author: 'charlie', body: 'New photos from yesterday evening on the north quad. Sunset was unreal. #campus #design', ageHours: 6 },
    { author: 'dave', body: 'First week studying operating systems and my brain is spinning. #study #technology', ageHours: 10 },
    { author: 'emma', body: 'Alumni advice: focus on building real projects, not just collecting certificates! #alumni #study', ageHours: 14 },
    { author: 'fiona', body: 'Office hours moved to 3 PM tomorrow due to the faculty symposium. #campus #research', ageHours: 18 },
    { author: 'george', body: 'Intramural soccer tournament registration is open! Sign up your teams. #sports #campus', ageHours: 24 },
    { author: 'hannah', body: 'Found an amazing quiet reading spot on the 4th floor library corner. #study #campus', ageHours: 30 },
    { author: 'ian', body: 'The dining hall waffle machine is finally back in action today! #food #campus', ageHours: 36 },
    { author: 'julia', body: 'Looking for recommendations on the best intro biology electives! #study #campus', ageHours: 42 },
    { author: 'kevin', body: 'Hosting a virtual alumni AMA next Thursday about early career engineering. #alumni #events', ageHours: 48 },
    { author: 'laura', body: 'Special lecture on historical campus archives this Friday in Hall B. #research #events', ageHours: 56 },
    { author: 'alice', body: 'Coffee tasting meetup at the Student Union this afternoon! #food #events', ageHours: 64 },
    { author: 'bob', body: 'Benchmarking SQLite vs Cloudflare D1 for our edge deployment. Pretty impressive results! #technology #research', ageHours: 72 },
    { author: 'charlie', body: 'Poster design submissions for spring festival are now open. #design #events', ageHours: 80 },
    { author: 'dave', body: 'Group study session for Calc II tonight in the main lounge at 7pm. #study', ageHours: 88 },
    { author: 'emma', body: 'Great meeting current students at the career fair booth today! #alumni #campus', ageHours: 96 },
    { author: 'fiona', body: 'Undergraduate research assistant applications are due next Monday. #research #campus', ageHours: 104 },
    { author: 'george', body: 'Anyone watching the basketball championship game at the quad tonight? #sports #campus', ageHours: 112 },
    { author: 'hannah', body: 'Tips for midterm season: sleep at least 7 hours and stay hydrated! #study #campus', ageHours: 120 },
    // Several under 48h from expiry (age > 120h, e.g. 125h, 130h, 135h, 140h) -> ~43h, 38h, 33h, 28h left
    { author: 'ian', body: 'Reminder: student council voting ends in 40 hours. Make your voice heard! #campus #events', ageHours: 125 },
    { author: 'julia', body: 'Lost hydroflask found near the science building benches. Left at front desk. #campus', ageHours: 130 },
    { author: 'kevin', body: 'Don\'t forget to submit your graduation audit forms before the weekend! #alumni #campus', ageHours: 135 },
    { author: 'laura', body: 'Exhibition of student architectural blueprints ending this weekend. #design #events', ageHours: 140 },
    // Several under 24h from expiry (age > 144h, e.g. 147h, 152h, 156h, 160h, 163h, 166h) -> ~21h, 16h, 12h, 8h, 5h, 2h left
    { author: 'alice', body: 'Last chance to RSVP for the weekend hackathon keynote! #hackathon #events', ageHours: 147 },
    { author: 'bob', body: 'Flash sale at the campus bookstore ends tonight! 30% off all hoodies. #campus #food', ageHours: 152 },
    { author: 'charlie', body: 'Final gallery critique tonight at 6 PM. Hope to see you there! #design #events', ageHours: 156 },
    { author: 'dave', body: 'Tonight is the midnight breakfast tradition at the dining center! #food #campus', ageHours: 160 },
    { author: 'emma', body: 'Submitting startup pitch deck in a few hours. Wish us luck! #technology #alumni', ageHours: 163 },
    { author: 'george', body: 'Intramural finals match starting in 2 hours on court 1! #sports #events', ageHours: 166 },
  ];

  const postIds: string[] = [];

  for (let i = 0; i < postSpecs.length; i++) {
    const spec = postSpecs[i]!;
    const postId = `pst_seed_${i + 1}`;
    postIds.push(postId);
    const authorId = `usr_${spec.author}`;
    const ageMs = spec.ageHours * 3600 * 1000;
    const createdAt = new Date(now - ageMs).toISOString();
    // Default 7 day lifespan
    const expiresAt = new Date(now - ageMs + 7 * 24 * 3600 * 1000).toISOString();

    await d1.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(postId, authorId, spec.body, createdAt, expiresAt, 'active')
      .run();

    // Link hashtags to topics
    for (const t of topicList) {
      if (spec.body.toLowerCase().includes(`#${t.slug}`)) {
        await d1.prepare('INSERT OR IGNORE INTO post_topics (post_id, topic_id, confidence) VALUES (?, ?, ?)')
          .bind(postId, t.id, 1.0)
          .run();
      }
    }
  }

  // 3. Reactions (Likes)
  const likePairs = [
    ['pst_seed_1', 'usr_bob'], ['pst_seed_1', 'usr_charlie'], ['pst_seed_1', 'usr_dave'], ['pst_seed_1', 'usr_emma'],
    ['pst_seed_2', 'usr_alice'], ['pst_seed_2', 'usr_dave'], ['pst_seed_2', 'usr_fiona'],
    ['pst_seed_3', 'usr_alice'], ['pst_seed_3', 'usr_bob'], ['pst_seed_3', 'usr_george'],
    ['pst_seed_5', 'usr_alice'], ['pst_seed_5', 'usr_bob'], ['pst_seed_5', 'usr_dave'],
    ['pst_seed_7', 'usr_hannah'], ['pst_seed_7', 'usr_ian'], ['pst_seed_7', 'usr_julia'],
    ['pst_seed_14', 'usr_alice'], ['pst_seed_14', 'usr_fiona'], ['pst_seed_14', 'usr_dave'],
    ['pst_seed_21', 'usr_alice'], ['pst_seed_21', 'usr_bob'],
    ['pst_seed_25', 'usr_bob'], ['pst_seed_25', 'usr_charlie'], ['pst_seed_25', 'usr_dave'],
    ['pst_seed_28', 'usr_alice'], ['pst_seed_28', 'usr_ian'], ['pst_seed_28', 'usr_julia'],
  ];

  for (const [pId, uId] of likePairs) {
    await d1.prepare('INSERT OR IGNORE INTO post_reactions (post_id, user_id, type, created_at) VALUES (?, ?, ?, ?)')
      .bind(pId, uId, 'like', nowIso)
      .run();
  }

  // 4. Comments
  const comments = [
    { id: 'cmt_seed_1', postId: 'pst_seed_1', authorId: 'usr_bob', body: 'Count me in! Building edge tooling.' },
    { id: 'cmt_seed_2', postId: 'pst_seed_1', authorId: 'usr_charlie', body: 'I can help with frontend and UI design.' },
    { id: 'cmt_seed_3', postId: 'pst_seed_2', authorId: 'usr_fiona', body: 'Great work Bob! Would love to discuss this in lab.' },
    { id: 'cmt_seed_4', postId: 'pst_seed_3', authorId: 'usr_alice', body: 'Gorgeous shot Charlie!' },
    { id: 'cmt_seed_5', postId: 'pst_seed_5', authorId: 'usr_dave', body: 'Needed to hear this today. Thanks Emma!' },
    { id: 'cmt_seed_6', postId: 'pst_seed_9', authorId: 'usr_julia', body: 'Heading there right now!' },
    { id: 'cmt_seed_7', postId: 'pst_seed_14', authorId: 'usr_alice', body: 'D1 + SQLite local dev is super responsive.' },
    { id: 'cmt_seed_8', postId: 'pst_seed_25', authorId: 'usr_bob', body: 'Registered and ready to go.' },
    { id: 'cmt_seed_9', postId: 'pst_seed_28', authorId: 'usr_hannah', body: 'Best campus tradition of the semester!' },
  ];

  for (const c of comments) {
    const commentExpiry = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
    await d1.prepare('INSERT OR IGNORE INTO comments (id, post_id, author_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.id, c.postId, c.authorId, c.body, nowIso, commentExpiry)
      .run();
  }

  // 5. Follows
  const followPairs = [
    ['usr_alice', 'usr_bob'], ['usr_alice', 'usr_charlie'], ['usr_alice', 'usr_fiona'], ['usr_alice', 'usr_emma'],
    ['usr_bob', 'usr_alice'], ['usr_bob', 'usr_charlie'], ['usr_bob', 'usr_dave'], ['usr_bob', 'usr_george'],
    ['usr_charlie', 'usr_alice'], ['usr_charlie', 'usr_bob'], ['usr_charlie', 'usr_hannah'],
    ['usr_dave', 'usr_alice'], ['usr_dave', 'usr_bob'], ['usr_dave', 'usr_charlie'],
    ['usr_emma', 'usr_alice'], ['usr_emma', 'usr_fiona'], ['usr_emma', 'usr_kevin'],
    ['usr_fiona', 'usr_alice'], ['usr_fiona', 'usr_bob'], ['usr_fiona', 'usr_laura'],
    ['usr_george', 'usr_alice'], ['usr_george', 'usr_bob'],
    ['usr_hannah', 'usr_charlie'], ['usr_hannah', 'usr_julia'],
    ['usr_ian', 'usr_alice'], ['usr_ian', 'usr_dave'],
    ['usr_julia', 'usr_hannah'], ['usr_julia', 'usr_dave'],
  ];

  for (const [follower, followed] of followPairs) {
    await d1.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)')
      .bind(follower, followed, nowIso)
      .run();
  }

  // 6. Blocks (2 blocks)
  await d1.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .bind('usr_alice', 'usr_kevin', nowIso)
    .run();
  await d1.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .bind('usr_bob', 'usr_ian', nowIso)
    .run();

  // 7. Conversations (3 conversations with a few messages each, including image-less reply chains)
  const msgExpiry = new Date(now + 14 * 24 * 3600 * 1000).toISOString();

  // Conversation 1: Alice & Bob
  const conv1 = 'conv_seed_1';
  await d1.prepare('INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)').bind(conv1, nowIso).run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv1, 'usr_alice').run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv1, 'usr_bob').run();

  const conv1Msgs = [
    { id: 'msg_seed_1', sender: 'usr_alice', body: 'Hey Bob, are you going to the campus hackathon this weekend?' },
    { id: 'msg_seed_2', sender: 'usr_bob', body: 'Yeah! Working on an edge AI project with Charlie.' },
    { id: 'msg_seed_3', sender: 'usr_alice', body: 'Awesome! Let\'s grab coffee beforehand to sync up.' },
    { id: 'msg_seed_4', sender: 'usr_bob', body: 'Sounds like a plan! See you at 10 AM by the cafe.' },
  ];

  for (const m of conv1Msgs) {
    await d1.prepare('INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(m.id, conv1, m.sender, m.body, nowIso, msgExpiry)
      .run();
  }

  // Conversation 2: Charlie & Dave
  const conv2 = 'conv_seed_2';
  await d1.prepare('INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)').bind(conv2, nowIso).run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv2, 'usr_charlie').run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv2, 'usr_dave').run();

  const conv2Msgs = [
    { id: 'msg_seed_5', sender: 'usr_charlie', body: 'Did you review the slides for CS201 distributed systems?' },
    { id: 'msg_seed_6', sender: 'usr_dave', body: 'Just reading through chapter 4 now. Raft algorithm is tricky!' },
    { id: 'msg_seed_7', sender: 'usr_charlie', body: 'Let me know if you want to study together in the library.' },
  ];

  for (const m of conv2Msgs) {
    await d1.prepare('INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(m.id, conv2, m.sender, m.body, nowIso, msgExpiry)
      .run();
  }

  // Conversation 3: Emma & Fiona (image-less reply chain)
  const conv3 = 'conv_seed_3';
  await d1.prepare('INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)').bind(conv3, nowIso).run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv3, 'usr_emma').run();
  await d1.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(conv3, 'usr_fiona').run();

  const conv3Msgs = [
    { id: 'msg_seed_8', sender: 'usr_emma', body: 'Prof. Fiona, wonderful to see the new department updates in the newsletter!' },
    { id: 'msg_seed_9', sender: 'usr_fiona', body: 'Thank you Emma! So glad you reached out. How is the startup treating you?' },
    { id: 'msg_seed_10', sender: 'usr_emma', body: 'Going great! We are actually looking for campus summer interns soon.' },
    { id: 'msg_seed_11', sender: 'usr_fiona', body: 'That is fantastic. I will share the opening with our senior class right away.' },
  ];

  for (const m of conv3Msgs) {
    await d1.prepare('INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(m.id, conv3, m.sender, m.body, nowIso, msgExpiry)
      .run();
  }

  return {
    usersCount: SEEDED_USERS.length,
    postsCount: postSpecs.length,
    reactionsCount: likePairs.length,
    commentsCount: comments.length,
    followsCount: followPairs.length,
    blocksCount: 2,
    conversationsCount: 3,
  };
}

// CLI runner
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const stats = await seedDevDatabase();
    console.log(`[Seed] Successfully seeded local dev database:`);
    console.log(` - ${stats.usersCount} users with sessions`);
    console.log(` - ${stats.postsCount} posts (with varied expiry states)`);
    console.log(` - ${stats.reactionsCount} reactions`);
    console.log(` - ${stats.commentsCount} comments`);
    console.log(` - ${stats.followsCount} follows`);
    console.log(` - ${stats.blocksCount} blocks`);
    console.log(` - ${stats.conversationsCount} conversations`);
  } catch (err: any) {
    console.error(`[Seed Error] ${err.message}`);
    process.exit(1);
  }
}
