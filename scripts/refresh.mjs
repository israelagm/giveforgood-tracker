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

// Alerts. CHAT_WEBHOOK comes from a repo secret; with it unset the script
// still refreshes data.json and simply posts nothing.
const CHAT_WEBHOOK = process.env.CHAT_WEBHOOK || '';
const ALERT_TOP_N = Number(process.env.ALERT_TOP_N || 10);
const DOLLAR_MILESTONE = Number(process.env.DOLLAR_MILESTONE || 1000);
const DONOR_MILESTONE = Number(process.env.DONOR_MILESTONE || 25);
const BIG_GIFT = Number(process.env.BIG_GIFT_DOLLARS || 250);
const ANNOUNCE_EVERY_DONATION = process.env.ANNOUNCE_EVERY_DONATION === 'true';

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

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

function valueLabel(p, v) {
  if (v == null) return '—';
  return p.field === 'dollars_in_cents'
    ? '$' + fmt(v / 100)
    : fmt(v) + ' ' + (p.rankBy === 'donors' ? 'donors' : 'donations');
}

function rankByLabel(rankBy) {
  return rankBy === 'donors' ? 'donor count'
    : rankBy === 'donations' ? 'number of donations' : 'dollars raised';
}

const timeET = (iso) =>
  new Date(iso).toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

/** Recent gifts, for big-gift alerts. Returns [alerts, newestId]. */
async function donationAlerts(lastSeen) {
  let list = [];
  try {
    const body = await getJSON(
      `${BASE}/api/v4/story/${URN}/recent_donations.json?page=1&per_page=25`);
    list = body.donation || [];
  } catch { return [[], lastSeen]; }
  if (!list.length) return [[], lastSeen];

  const newest = list[0].id;
  if (!lastSeen) return [[], newest];   // first run: baseline only

  const out = [];
  // Newest first from the API; reverse so messages read in arrival order.
  for (const d of list.filter((x) => x.id > lastSeen).reverse()) {
    const amount = (d.amount_in_cents || 0) / 100;
    const who = d.show_as_anonymous ? 'An anonymous donor' : (d.full_name || 'Someone');
    if (amount >= BIG_GIFT) {
      out.push(`⭐ Big donation: ${who} gave $${fmt(amount)}!` +
        (d.comment ? ` “${d.comment}”` : ''));
    } else if (ANNOUNCE_EVERY_DONATION) {
      out.push(`💛 ${who} gave $${fmt(amount)}.`);
    }
  }
  return [out, newest];
}

/** Everything worth saying out loud between two readings. */
function buildAlerts(prev, next) {
  const alerts = [];
  if (!prev || !prev.org) return alerts;   // first run: baseline only

  const before = Object.fromEntries((prev.prizes || []).map((p) => [p.id, p]));

  for (const now of next.prizes) {
    const was = before[now.id];
    if (!was) continue;

    if (was.status === 'upcoming' && now.status === 'live') {
      alerts.push(`🟢 ${now.prize} is OPEN until ${timeET(now.end)} — ranked by ` +
        `${rankByLabel(now.rankBy)}. Every gift counts now.`);
    }

    if (was.status === 'live' && now.status === 'final') {
      alerts.push(now.rank
        ? `🏁 ${now.prize} is over — we finished #${now.rank} of ${now.total} ` +
          `with ${valueLabel(now, now.value)}.`
        : `🏁 ${now.prize} is over.`);
    }

    if (now.status === 'live' && was.rank && now.rank && was.rank !== now.rank) {
      const tail = now.gap != null && now.chasing
        ? ` — ${valueLabel(now, now.gap)} behind ${now.chasing}.` : '.';
      if (now.rank < was.rank && now.rank <= ALERT_TOP_N) {
        alerts.push(`⬆️ ${now.prize}: up to #${now.rank} (was #${was.rank})${tail}`);
      } else if (now.rank > was.rank && was.rank <= ALERT_TOP_N) {
        alerts.push(`⬇️ ${now.prize}: slipped to #${now.rank} (was #${was.rank})${tail}`);
      }
    }
  }

  if (DOLLAR_MILESTONE > 0) {
    const b = Math.floor(prev.org.raised / DOLLAR_MILESTONE);
    const a = Math.floor(next.org.raised / DOLLAR_MILESTONE);
    if (a > b) {
      alerts.push(`💰 Just crossed $${fmt(a * DOLLAR_MILESTONE)} — now at ` +
        `$${fmt(next.org.raised)}.`);
    }
  }

  if (DONOR_MILESTONE > 0) {
    const b = Math.floor(prev.org.donors / DONOR_MILESTONE);
    const a = Math.floor(next.org.donors / DONOR_MILESTONE);
    if (a > b) {
      alerts.push(`🎉 Donor #${a * DONOR_MILESTONE} is in — ${next.org.donors} donors so far.`);
    }
  }

  if (next.org.goal && prev.org.raised < next.org.goal && next.org.raised >= next.org.goal) {
    alerts.push(`🏆 GOAL MET! $${fmt(next.org.raised)} of our $${fmt(next.org.goal)} goal.`);
  }

  return alerts;
}

async function postAlerts(alerts, state) {
  if (!alerts.length) return;
  if (!CHAT_WEBHOOK) {
    console.log('(no CHAT_WEBHOOK set) would have posted:\n  ' + alerts.join('\n  '));
    return;
  }

  const liveWindow = state.prizes.find((p) => p.status === 'live' && p.rank);
  const header = `${LABEL} — $${fmt(state.org.raised)} · ${state.org.donors} donors` +
    (liveWindow ? `\nLive now — ${liveWindow.prize}: #${liveWindow.rank} of ${liveWindow.total}` : '');
  const text = `${header}\n\n${alerts.join('\n')}\n\n${state.config.url}`;

  try {
    const res = await fetch(CHAT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    console.log(`posted ${alerts.length} alert(s) → ${res.status}`);
  } catch (e) {
    console.warn('chat post failed: ' + e.message);
  }
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
  const mine = boards.filter((b) => !b.tier || b.tier === tier);

  const prizes = [];
  for (const b of mine) {
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

  // Our own totals come from story.json — the same live source the org's
  // public profile page reads, so this always matches what a donor sees
  // there. It keeps climbing through the Sep 11 late-giving window even
  // after every prize leaderboard has closed and frozen, which a board
  // entry (tried here previously) can't do.
  //
  // story.json's own donation count is unusable though: `cached_number_donations`
  // comes back null for this org, and falling back to `total_donors` silently
  // made "donations" always equal "donors" on the page (donors and donations
  // are not the same thing — a donor who gives twice is one donor, two
  // donations). recent_donations.json's `total_count` is a real, live tally
  // of the donation ledger itself, so it stays accurate even as new gifts
  // land, and a per_page=1 request is enough to read it. avgGift is derived
  // from these two rather than trusted from a third field, so the header
  // numbers are always internally consistent — avg × donations reconciles
  // exactly with the total shown, no matter which moment they were read at.
  const raised = (o.total_amount_raised_in_cents || 0) / 100;
  const donors = o.total_donors || 0;
  let donations = donors;   // last-resort only, if the ledger call fails
  try {
    const ledger = await getJSON(
      `${BASE}/api/v4/story/${URN}/recent_donations.json?page=1&per_page=1`);
    if (ledger.total_count) donations = ledger.total_count;
  } catch { /* keep the fallback */ }

  const state = {
    ts: new Date().toISOString(),
    tier,
    org: {
      raised,
      donors,
      donations,
      avgGift: donations > 0 ? raised / donations : 0,
      goal: (o.goal_amount_in_cents || 0) / 100,
    },
    prizes,
    config: { label: LABEL, url: `${BASE}/organization/${URN}` },
  };

  const fs = await import('node:fs/promises');

  // The committed data.json is our previous reading — exactly the state we
  // need to diff against, with no extra storage.
  let prev = null;
  try { prev = JSON.parse(await fs.readFile('data.json', 'utf8')); } catch {}

  const [giftAlerts, newestDonationId] =
    await donationAlerts(prev && prev.lastDonationId);
  state.lastDonationId = newestDonationId;

  const alerts = [...buildAlerts(prev, state), ...giftAlerts];
  await postAlerts(alerts, state);

  await fs.writeFile('data.json', JSON.stringify(state, null, 1));

  console.log(`tier=${tier} raised=$${state.org.raised} donors=${state.org.donors}`);
  for (const p of prizes) {
    const v = p.field === 'dollars_in_cents' ? `$${(p.value ?? 0) / 100}` : p.value;
    console.log(`  ${p.prize.padEnd(28)} ${p.status.padEnd(9)} ${p.rank ? '#' + p.rank + '/' + p.total : '—'}  ${v}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
