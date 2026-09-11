/**
 * Give for Good Louisville — live JSON endpoint.
 *
 * Deploy this as a web app and it returns the same shape as data.json, but
 * computed fresh on every request. It exists to solve one problem: the event
 * API sends no CORS headers, so a browser on github.io cannot call it. This
 * runs on Google's servers, where CORS does not apply, and its own response
 * IS readable cross-origin — so the page can poll it every few seconds with
 * no cache and no rate limit.
 *
 * DEPLOY
 *   1. script.google.com → New project. Paste this in. Save.
 *   2. Deploy → New deployment → Web app
 *        Execute as:      Me
 *        Who has access:  Anyone            ← must be Anyone, not "anyone with Google account"
 *   3. Copy the /exec URL and put it in LIVE_ENDPOINT at the top of index.html.
 *
 * Nothing here reads or writes your Google data; it only makes outbound
 * requests to giveforgoodlouisville.org.
 */

var ORG_URN = 'Hawthorne-Elementary-Pta';
var ORG_LABEL = 'Hawthorne Elementary PTA';
var YEAR = '2026';
var BASE = 'https://www.giveforgoodlouisville.org';
var PAGE = '/p/leaderboards';

var PER_PAGE = 200;   // the API caps here; ask for more and it returns 10
var MAX_PAGES = 4;

var RANK_FIELD = {
  dollars: 'dollars_in_cents',
  donors: 'donors',
  donations: 'donations'
};

function doGet() {
  var payload;
  try {
    payload = JSON.stringify(buildState_());
  } catch (e) {
    payload = JSON.stringify({ error: String(e) });
  }
  return ContentService.createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function buildState_() {
  var cache = CacheService.getScriptCache();

  // One shared 20-second cache across all viewers. Ten people watching costs
  // the event's API the same as one.
  var hit = cache.get('state');
  if (hit) return JSON.parse(hit);

  var boards = getBoards_();
  var tier = getTier_(boards);
  var mine = boards.filter(function (b) { return !b.tier || b.tier === tier; });

  var prizes = fetchStandings_(mine);
  var org = fetchOrg_();

  var state = {
    ts: new Date().toISOString(),
    tier: tier,
    org: org,
    prizes: prizes,
    config: { label: ORG_LABEL, url: BASE + '/organization/' + ORG_URN }
  };

  cache.put('state', JSON.stringify(state), 20);
  return state;
}

function json_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(res.getResponseCode() + ' ' + url);
  return JSON.parse(res.getContentText());
}

/**
 * Our own totals come from story.json — the same live source the org's
 * public profile page reads, so this always matches what a donor sees there.
 * It keeps climbing through the Sep 11 late-giving window even after every
 * prize leaderboard has closed and frozen; a leaderboard entry (tried here
 * previously) can't do that, since every 2026 board's window ends Sep 10
 * 23:59:59.
 *
 * story.json's own donation count is unusable though: `cached_number_donations`
 * comes back null for this org, and falling back to `total_donors` silently
 * made "donations" always equal "donors" on the page (a donor who gives
 * twice is one donor, two donations). recent_donations.json's `total_count`
 * is a real, live tally of the donation ledger, so it stays accurate as new
 * gifts land; a per_page=1 call is enough to read it. avgGift is derived from
 * these two rather than trusted from a third field, so the numbers shown are
 * always internally consistent.
 */
function fetchOrg_() {
  var d = json_(BASE + '/api/v4/story/' + ORG_URN + '.json');
  var raised = (d.total_amount_raised_in_cents || 0) / 100;
  var donors = d.total_donors || 0;
  var donations = donors;   // last-resort only, if the ledger call fails

  try {
    var ledger = json_(BASE + '/api/v4/story/' + ORG_URN +
      '/recent_donations.json?page=1&per_page=1');
    if (ledger.total_count) donations = ledger.total_count;
  } catch (e) { /* keep the fallback */ }

  return {
    raised: raised,
    donors: donors,
    donations: donations,
    avgGift: donations > 0 ? raised / donations : 0,
    goal: (d.goal_amount_in_cents || 0) / 100
  };
}

/** "2026 Morning Rush | Tier 1" -> { prize: "Morning Rush", tier: "Tier 1" } */
function parseName_(name) {
  var s = String(name || '').replace(new RegExp('^' + YEAR + '\\s*'), '');
  var tier = null;
  var m = s.match(/[|\-–]\s*(Tier\s*\d)\s*$/i);
  if (m) { tier = m[1].replace(/\s+/, ' '); s = s.slice(0, m.index); }
  return { prize: s.replace(/[\s|\-–]+$/, '').trim(), tier: tier };
}

function stripTags_(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&ndash;/g, '–').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Joins the leaderboard records (windows, tiers) with the leaderboards page's
 * block config (which metric each prize is judged on).
 *
 * The metric has to come from the page. The leaderboard record carries a
 * `rank_by` that reads "dollars" on every 2026 board, including Grand Prizes
 * (awarded for most donations) and the timed windows (most donors).
 */
function getBoards_() {
  var records = {};
  for (var page = 1; page <= 5; page++) {
    var body = json_(BASE + '/api/v4/leaderboards.json?per_page=100&page=' + page);
    var list = body.leaderboards || body;
    if (!list.length) break;
    list.forEach(function (l) {
      if (!l.visible || String(l.name || '').indexOf(YEAR) !== 0) return;
      var p = parseName_(l.name);
      records[l.id] = {
        id: l.id, name: l.name, prize: p.prize, tier: p.tier,
        rankBy: l.rank_by || 'dollars', start: l.start_at, end: l.end_at,
        members: l.total_member_count || 0
      };
    });
    if (list.length < 100) break;
  }

  var blocks = json_(BASE + '/api/v4/modular_contents/' +
    encodeURIComponent(PAGE) + '/find_by_key.json').data.blocks || [];

  var scanned = blocks.map(function (b) {
    var heads = [], widgets = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Object.prototype.toString.call(o) === '[object Array]') { o.forEach(walk); return; }
      if (o.key === 'leaderboard' && o.leaderboard) widgets.push(o.leaderboard);
      if (typeof o.content === 'string' && /<h[1-3]/i.test(o.content)) heads.push(stripTags_(o.content));
      Object.keys(o).forEach(function (k) { walk(o[k]); });
    })(b);
    return { heads: heads, widgets: widgets };
  });

  var boards = [], shown = {};
  scanned.forEach(function (blk, i) {
    if (!blk.widgets.length) return;
    var prize = '';
    for (var j = i; j >= 0; j--) {
      if (scanned[j].heads.length) { prize = scanned[j].heads[scanned[j].heads.length - 1]; break; }
    }
    blk.widgets.forEach(function (w) {
      var rec = records[w.id];
      if (!rec) return;
      var metric = String(w.sort_by || 'dollars-desc').split('-')[0];
      shown[w.id] = true;
      boards.push({
        key: w.id + ':' + metric, id: w.id, name: rec.name,
        prize: prize || rec.prize, view: w.title || null, tier: rec.tier,
        metric: metric, start: rec.start, end: rec.end, members: rec.members
      });
    });
  });

  Object.keys(records).forEach(function (id) {
    if (shown[id]) return;
    var r = records[id];
    boards.push({
      key: r.id + ':' + r.rankBy, id: r.id, name: r.name, prize: r.prize,
      view: null, tier: r.tier, metric: r.rankBy,
      start: r.start, end: r.end, members: r.members
    });
  });

  boards.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  return boards;
}

var entryCache_ = {};
function fetchEntries_(id, members) {
  if (entryCache_[id]) return entryCache_[id];
  var pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil((members || 1) / PER_PAGE)));
  var reqs = [];
  for (var p = 1; p <= pages; p++) {
    reqs.push({ url: BASE + '/api/v4/leaderboards/' + id +
      '/leaderboard_entries.json?per_page=' + PER_PAGE + '&page=' + p,
      muteHttpExceptions: true });
  }
  var out = [];
  UrlFetchApp.fetchAll(reqs).forEach(function (res) {
    if (res.getResponseCode() !== 200) return;
    try {
      (JSON.parse(res.getContentText()).entries || []).forEach(function (e) { out.push(e); });
    } catch (e) {}
  });
  entryCache_[id] = out;
  return out;
}

/** Our revenue tier, found by looking for our URN in the tiered boards. */
function getTier_(boards) {
  var seen = {};
  var tiered = boards.filter(function (b) {
    if (!b.tier || seen[b.id]) return false;
    seen[b.id] = true;
    return true;
  }).sort(function (a, b) {
    return (/grand/i.test(a.prize) ? 0 : 1) - (/grand/i.test(b.prize) ? 0 : 1);
  });

  for (var i = 0; i < tiered.length; i++) {
    var entries = fetchEntries_(tiered[i].id, tiered[i].members);
    for (var j = 0; j < entries.length; j++) {
      if (entries[j].urn === ORG_URN) return tiered[i].tier;
    }
  }
  return null;
}

function labelOf_(b) {
  return b.tier ? (b.prize || b.name) : (b.view || b.prize || b.name);
}

function fetchStandings_(boards) {
  var now = Date.now();
  return boards.map(function (b) {
    var field = RANK_FIELD[b.metric] || 'dollars_in_cents';
    var sorted = fetchEntries_(b.id, b.members).slice().sort(function (x, y) {
      return y[field] - x[field];
    });

    var rank = null, value = null, gap = null, chasing = null;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].urn === ORG_URN) {
        value = sorted[i][field];
        // Before we score, everyone is tied at zero and our slot is arbitrary.
        rank = value > 0 ? i + 1 : null;
        if (rank && rank > 1) {
          gap = sorted[rank - 2][field] - value;
          chasing = sorted[rank - 2].name;
        }
        break;
      }
    }

    var start = new Date(b.start).getTime(), end = new Date(b.end).getTime();
    return {
      id: b.key, boardId: b.id, prize: labelOf_(b), tier: b.tier, name: b.name,
      rankBy: b.metric, start: b.start, end: b.end,
      status: now < start ? 'upcoming' : (now > end ? 'final' : 'live'),
      rank: rank, value: value, field: field,
      total: sorted.length || b.members,
      leader: sorted.length ? { name: sorted[0].name, value: sorted[0][field] } : null,
      gap: gap, chasing: chasing,
      scored: sorted.length > 0 && sorted[0][field] > 0
    };
  });
}
