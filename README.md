# Give for Good Louisville — Hawthorne Elementary PTA prize tracker

A single page showing where Hawthorne stands in **every prize category**, with
finished prizes keeping their final placement.

**Live page:** https://israelagm.github.io/giveforgood-tracker/

## How it works

```
GitHub Actions          →  data.json           →  index.html
  fetches the event API     committed to main      reads it from
  server-side, ~1/min                              raw.githubusercontent.com
```

The event's standings endpoints send no `Access-Control-Allow-Origin` header,
so a browser on `github.io` cannot call them — the request is blocked before it
leaves the device. The scheduled Action runs server-side, where CORS doesn't
apply, and commits the result into the repo.

The page reads that file from `raw.githubusercontent.com`, not from its own
origin. GitHub Pages rebuilds on every commit, and when data refreshes about
once a minute those builds queue and cancel each other — the Pages copy of
`data.json` can sit several minutes behind the repo. `raw` serves the newest
commit immediately and sends `access-control-allow-origin: *`, so the
cross-origin read is allowed. Pages only has to serve `index.html`, which
rarely changes. The page falls back to the same-origin copy if `raw` fails.

Cron's floor is five minutes, so each run loops internally and refreshes about
once a minute until the next run takes over.

## Which metric each prize uses

Every prize is judged on a different number, and the leaderboard record's own
`rank_by` field **does not tell you which** — for 2026 it reads `"dollars"` on
every board. That is not what the prizes are awarded on:

| Prize | Judged on | Rules language |
|---|---|---|
| Grand Prizes | **donations** | "awarded for Most Donations from September 7–10" |
| Morning Rush | **donors** | "the most online donors between 8 – 10 a.m. ET" |
| Mid-Morning Break For It | **donors** | same, 10 a.m. – 12 p.m. |
| Afternoon Drive | **donors** | same, 1 – 3 p.m. |
| Bridging the Gap | **donors** | same, 4 – 6 p.m. |
| Evening Break For It | **donors** | same, 7 – 9 p.m. |
| Late Night Push | **donors** | same, 10 – 11 p.m. |

The authority is the leaderboards **page**, not the leaderboard record: each
prize card there carries a `sort_by` matching the published rules. The script
reads that page config, so if the organizers change a prize's metric it follows
without a code edit.

A donation and a donor are not the same thing — someone who gives twice is one
donor and two donations, which is why Grand Prize and Morning Rush can put us
in different positions on the same day.

## API endpoints used

All public, no key required.

| Endpoint | Gives you |
|---|---|
| `/api/v4/modular_contents/%2Fp%2Fleaderboards/find_by_key.json` | which metric each prize is judged on |
| `/api/v4/leaderboards.json?per_page=100&page=N` | every prize board: name, tier, window |
| `/api/v4/leaderboards/<id>/leaderboard_entries.json?per_page=200&page=N` | standings for one prize |
| `/api/v4/story/<slug>.json` | our own totals |

`per_page` caps at **200** on the leaderboard endpoints — ask for more and the
API silently returns 10 instead of erroring.

## Configuration

Defaults are set for Hawthorne. Override with environment variables in the
workflow if you fork this for another organization:

| Variable | Default |
|---|---|
| `ORG_URN` | `Hawthorne-Elementary-Pta` (last part of the profile URL) |
| `ORG_LABEL` | `Hawthorne Elementary PTA` |
| `EVENT_YEAR` | `2026` |

## Running it by hand

```bash
node scripts/refresh.mjs
```

Writes `data.json` and prints the standings. Or use **Actions → Refresh
leaderboard data → Run workflow** to force a refresh without waiting for cron.

## Limits worth knowing

- **GitHub delays scheduled workflows under load.** The internal loop keeps
  refreshing between cron firings, but a delayed run still leaves a gap. The
  page shows how old the reading is and warns past three minutes.
- Status (upcoming / live / final) is recomputed in the browser, not trusted
  from the file — otherwise a window that closed after the last refresh would
  still show LIVE. A closed window whose numbers predate the close is marked
  provisional until the next refresh confirms it.
- Prize *rules* aren't in the API, only leaderboards. Golden Tickets,
  #WhyIGive, Ambassador grants and randomized drawings aren't leaderboard-driven
  and won't appear here.
- Awards are audited through Sept 25. For prize purposes a "donation" is a
  unique online gift of **$5 or more**; that floor is applied at audit, not on
  the live leaderboard, so the audited count can come in slightly lower.
- Before anyone scores in a window every org is tied at zero, so the page shows
  "no donations yet" rather than an arbitrary rank.

## Chat alerts

Set a Google Chat webhook as a repo secret and the refresh job posts on window
open and close (with final placement), rank changes inside the top 10, dollar
and donor milestones, and single donations of $250 or more:

```bash
gh secret set CHAT_WEBHOOK --repo israelagm/giveforgood-tracker
```

Get the URL from your Chat space: **Apps & integrations → Webhooks → Add**.
Without the secret the job still refreshes the page and just logs what it would
have posted. Tuning knobs (`ALERT_TOP_N`, `DOLLAR_MILESTONE`, `DONOR_MILESTONE`,
`BIG_GIFT_DOLLARS`, `ANNOUNCE_EVERY_DONATION`) are environment variables read by
`scripts/refresh.mjs`.
