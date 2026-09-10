# Give for Good Louisville — Hawthorne Elementary PTA prize tracker

A single page showing where Hawthorne stands in **every prize category**, with
finished prizes keeping their final placement.

**Live page:** https://israelagm.github.io/giveforgood-tracker/

## How it works

```
GitHub Actions (every 5 min)  →  data.json  →  index.html
   fetches the event API         committed      reads same-origin
   server-side                   to the repo
```

The event's standings endpoints send no `Access-Control-Allow-Origin` header,
so a browser on `github.io` cannot call them — the request is blocked before it
leaves the device. The scheduled Action runs server-side, where CORS doesn't
apply, and commits the result into the repo. The page then reads `data.json`
from its own origin, which is always allowed.

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

- **Scheduled workflows have a 5-minute minimum and GitHub delays them under
  load** — sometimes well past the scheduled time. The page shows how old the
  reading is; don't assume it's current to the minute during a tight race.
- Prize *rules* aren't in the API, only leaderboards. Golden Tickets,
  #WhyIGive, Ambassador grants and randomized drawings aren't leaderboard-driven
  and won't appear here.
- Awards are audited through Sept 25. For prize purposes a "donation" is a
  unique online gift of **$5 or more**; that floor is applied at audit, not on
  the live leaderboard, so the audited count can come in slightly lower.
- Before anyone scores in a window every org is tied at zero, so the page shows
  "no gifts yet" rather than an arbitrary rank.
