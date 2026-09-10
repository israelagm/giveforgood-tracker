/**
 * Fetches Hawthorne Elementary PTA's standing in every Give for Good
 * Louisville prize and writes it to data.json.
 *
 * Runs in GitHub Actions, not in a browser — which is the whole point. The
 * event's standings endpoints send no CORS headers, so a page served from
 * GitHub Pages can't call them. This script can, because it runs server-side;
 * the page then reads data.json from its own origin.
 */

const BASE = 'https://www.giveforgoodlouisville.org';
const URN = process.env.ORG_URN || 'Hawthorne-Elementary-Pta';
const LABEL = process.env.ORG_LABEL || 'Hawthorne Elementary PTA';
const YEAR = process.env.EVENT_YEAR || '2026';
const PAGE = process.env.LEADERBOARD_PAGE || '/p/leaderboards';

// The API caps per_page at 200; ask for more and it silently returns 10.
const PER_PAGE = 200;
const MAX_PAGES = 4;

const FIELD = {
  dollars: 'dollars_in_cents',
  donors: 'donors',
  donations: 'donations',
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const stripTags = (h) =>
  String(h || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ndash;/g, '–')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "2026 Morning Rush | Tier 1" -> { prize: "Morning Rush", tier: "Tier 1" } */
function parseName(name) {
  let s = String(name || '').replace(new RegExp(`^${YEAR}\\s*`), '');
  let tier = null;
  const m = s.match(/[|\-–]\s*(Tier\s*\d)\s*$/i);
  if (m) {
    tier = m[1].replace(/\s+/, ' ');
    s = s.slice(0, m.index);
  }
  return { prize: s.replace(/[\s|\-–]+$/, '').trim(), tier };
}

/** This year's visible leaderboard records. */
async function fetchBoardRecords() {
  const byId = {};
  for (let page = 1; page <= 5; page++) {
    const body = await getJSON(`${BASE}/api/v4/leaderboards.json?per_page=100&page=${page}`);
    const list = body.leaderboards || body;
    if (!list.length) break;
    for (const l of list) {
      if (!l.visible || !String(l.name || '').startsWith(YEAR)) continue;
      const { prize, tier } = parseName(l.name);
      byId[l.id] = {
        id: l.id, name: l.name, prize, tier,
        rankBy: l.rank_by || 'dollars',
        start: l.start_at, end: l.end_at,
        members: l.total_member_count || 0,
      };
    }
    if (list.length < 100) break;
  }
  return Object.values(byId);
}

/**
 * Which metric is each prize actually judged on?
 *
 * Not `rank_by` — for 2026 that reads "dollars" on every board, including
 * Grand Prizes (awarded for most donations) and the timed windows (most
 * donors). The leaderboards page's block config carries the real `sort_by`,
 * and it matches the published prize rules.
 */
async function fetchDisplayMap() {
  const url = `${BASE}/api/v4/modular_contents/${encodeURIComponent(PAGE)}/find_by_key.json`;
  const blocks = (await getJSON(url)).data.blocks || [];

  const scanned = blocks.map((b) => {
    const heads = [], widgets = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o.key === 'leaderboard' && o.leaderboard) widgets.push(o.leaderboard);
      if (typeof o.content === 'string' && /<h[1-3]/i.test(o.content)) {
        heads.push(stripTags(o.content));
      }
      Object.values(o).forEach(walk);
    })(b);
    return { heads, widgets };
  });

  const out = [];
  scanned.forEach((blk, i) => {
    if (!blk.widgets.length) return;
    let prize = '';
    for (let j = i; j >= 0; j--) {
      if (scanned[j].heads.length) { prize = scanned[j].heads.at(-1); break; }
    }
    for (const w of blk.widgets) {
      out.push({
        id: w.id,
        metric: String(w.sort_by || 'dollars-desc').split('-')[0],
        view: w.title || null,
        prize,
      });
    }
  });
  return out;
}

const entryCache = new Map();
async function fetchEntries(id, members) {
  if (entryCache.has(id)) return entryCache.get(id);
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil((members || 1) / PER_PAGE)));
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const body = await getJSON(
      `${BASE}/api/v4/leaderboards/${id}/leaderboard_entries.json?per_page=${PER_PAGE}&page=${p}`
    );
    out.push(...(body.entries || []));
  }
  entryCache.set(id, out);
  return out;
}

function labelOf(b) {
  return b.tier ? (b.prize || b.name) : (b.view || b.prize || b.name);
}

async function main() {
  const [records, views] = await Promise.all([fetchBoardRecords(), fetchDisplayMap()]);
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));

  // One board can appear several times under different metrics (the overall
  // board is published as Most Dollars, Most Donors and Most Donations), so a
  // prize is keyed by board id *and* metric.
  const boards = [];
  for (const v of views) {
    const rec = byId[v.id];
    if (!rec) continue;
    boards.push({
      key: `${v.id}:${v.metric}`, id: v.id, name: rec.name,
      prize: v.prize || rec.prize, view: v.view, tier: rec.tier,
      metric: v.metric, start: rec.start, end: rec.end, members: rec.members,
    });
  }
  const shown = new Set(boards.map((b) => b.id));
  for (const r of records) {
    if (shown.has(r.id)) continue;   // not on the page: fall back to rank_by
    boards.push({
      key: `${r.id}:${r.rankBy}`, id: r.id, name: r.name, prize: r.prize,
      view: null, tier: r.tier, metric: r.rankBy,
      start: r.start, end: r.end, members: r.members,
    });
  }
  boards.sort((a, b) => (a.start < b.start ? -1 : 1));

  // Our revenue tier, found by looking for our URN in the tiered boards.
  // Grand Prize boards run all event, so they're populated earliest.
  let tier = null;
  const tiered = boards
    .filter((b) => b.tier)
    .filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i)
    .sort((a, b) => (/grand/i.test(a.prize) ? 0 : 1) - (/grand/i.test(b.prize) ? 0 : 1));
  for (const b of tiered) {
    const entries = await fetchEntries(b.id, b.members);
    if (entries.some((e) => e.urn === URN)) { tier = b.tier; break; }
  }

  const now = Date.now();
  const prizes = [];
  for (const b of boards.filter((b) => !b.tier || b.tier === tier)) {
    const field = FIELD[b.metric] || 'dollars_in_cents';
    const sorted = (await fetchEntries(b.id, b.members))
      .slice()
      .sort((x, y) => y[field] - x[field]);

    let rank = null, value = null, gap = null, chasing = null;
    const at = sorted.findIndex((e) => e.urn === URN);
    if (at >= 0) {
      value = sorted[at][field];
      // Before we score, every org is tied at zero and our position in that
      // block is arbitrary — report no rank rather than a number that swings.
      rank = value > 0 ? at + 1 : null;
      if (rank && rank > 1) {
        gap = sorted[rank - 2][field] - value;
        chasing = sorted[rank - 2].name;
      }
    }

    const start = new Date(b.start).getTime();
    const end = new Date(b.end).getTime();

    prizes.push({
      id: b.key, boardId: b.id, prize: labelOf(b), tier: b.tier, name: b.name,
      rankBy: b.metric, start: b.start, end: b.end,
      status: now < start ? 'upcoming' : now > end ? 'final' : 'live',
      rank, value, field, total: sorted.length || b.members,
      leader: sorted.length ? { name: sorted[0].name, value: sorted[0][field] } : null,
      gap, chasing,
      scored: sorted.length > 0 && sorted[0][field] > 0,
    });
  }

  const o = await getJSON(`${BASE}/api/v4/story/${URN}.json`);
  const state = {
    ts: new Date().toISOString(),
    tier,
    org: {
      raised: (o.total_amount_raised_in_cents || 0) / 100,
      donors: o.total_donors || 0,
      donations: o.cached_number_donations || o.total_donors || 0,
      avgGift: (o.average_donation_in_cents || 0) / 100,
      goal: (o.goal_amount_in_cents || 0) / 100,
    },
    prizes,
    config: { label: LABEL, url: `${BASE}/organization/${URN}` },
  };

  const fs = await import('node:fs/promises');
  await fs.writeFile('data.json', JSON.stringify(state, null, 1));

  console.log(`tier=${tier} raised=$${state.org.raised} donors=${state.org.donors}`);
  for (const p of prizes) {
    const v = p.field === 'dollars_in_cents' ? `$${(p.value ?? 0) / 100}` : p.value;
    console.log(`  ${p.prize.padEnd(28)} ${p.status.padEnd(9)} ${p.rank ? '#' + p.rank + '/' + p.total : '—'}  ${v}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
