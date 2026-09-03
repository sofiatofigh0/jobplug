# JobPlug

A Chrome extension that tracks every job you apply to.

It watches for applications as you submit them, writes each one to a Google Sheet
with the company and compensation details it can find, then reads your Gmail
(read-only) to work out who replied and who invited you to interview — so you get
a real answer to *"how many did I apply to, and how many actually got back to me?"*

---

## What it does

**Detects applications automatically.** No button to press. The extension watches four
independent signals on any page you apply from and logs the application when they add up:

| Signal | What it catches |
|---|---|
| Network | A successful `POST` to an apply endpoint — how nearly every modern ATS submits |
| File | A resume-shaped file attached to the form (or dragged onto it) |
| Intent | A click on a button labelled *Submit application*, *Apply*, *Easy Apply*… |
| Outcome | Confirmation copy appearing on screen (*"we've received your application"*) |

Any one of these alone is noisy. Together they aren't — a single stray "Apply" click
never logs anything, but a resume upload followed by a successful submit does.

Board-specific rules ship for **Greenhouse, Lever, Ashby, Workday, LinkedIn, Indeed,
SmartRecruiters, Workable, iCIMS, Taleo, SuccessFactors, Wellfound, Rippling, Dover,
Breezy, Jobvite, BambooHR, Recruitee, Teamtailor, Pinpoint, Gem, ZipRecruiter and
Built In**, with a generic fallback for company career sites running something else.

**Records what the posting says.** Every row carries:

- Position, company, and a link back to the original job description
- Date applied, board/ATS, location
- **Which resume file you uploaded**, mapped to a version label you define
- Work mode — Remote / Hybrid / Onsite
- Compensation range as listed (hourly and monthly ranges are annualised so they compare)
- Company stage, valuation, total raised, last round, headcount, industry — *whenever the page states them*
- Status, interview-invite flag, first-response date, days to response, Gmail thread link

**Watches Gmail for replies.** Every 30 minutes (configurable) it searches only for mail
plausibly connected to a company you applied to, and classifies it:

`Acknowledged` → `Assessment / Take-home` → `Recruiter Screen` → `Interview` → `Onsite / Final` → `Offer`, or `Rejected`

Rejections deliberately outrank interview language, because rejection templates so often
read *"we won't be moving you forward to the interview stage."* Job alerts and cold recruiter
outreach are filtered out before they can distort anything. Applications with no reply after
21 days are marked **Ghosted**.

**Aggregates it.** The popup and the sheet's Dashboard tab both show:

- Applications submitted · heard back · interview invites · offers, with rates
- Median days to first response, and to an interview invite
- **Interview rate broken down by resume version** — which one actually lands
- Breakdowns by work mode, company stage, board, and week

---

## Install

```bash
git clone -b claude/job-app-tracker-extension-dajhwt https://github.com/sofiatofigh0/jobplug.git
cd jobplug
npm run check        # verifies the extension loads cleanly
```

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. The settings page opens. Follow **[SETUP.md](SETUP.md)** to create the Google OAuth
   client (~10 minutes, once), then click **Connect Google**

A spreadsheet named *Job Applications — JobPlug* is created in your Drive automatically.

There's no build step — `extension/` loads as-is, and Node is only needed for the scripts
below.

> **Working in Codespaces or a remote devcontainer?** Chrome can't load an extension from a
> remote container — *Load unpacked* only sees your local disk. Run `npm run pin-id` once
> (fixes the extension ID so it survives moving), then `npm run package`, and download the
> single `jobplug-extension.zip` it writes. Details in [SETUP.md](SETUP.md#0-get-the-files-onto-the-machine-running-chrome).

---

## The spreadsheet

Three tabs:

- **Applications** — one row per application, 33 columns. Frozen header, filter view,
  colour-coded status, a status dropdown, and a live `Days to Response` formula.
- **Dashboard** — headline KPIs as live formulas (so they stay honest if you edit rows
  by hand) plus breakdown tables refreshed on every sync.
- **Email Log** — every classified email, with its category and confidence. This is the
  audit trail: when a status looks wrong, this tab shows you why.

**Edits you make in Sheets flow back.** Notes, resume version, stage, valuation, headcount
and work mode are read back on each sync. Status is special: it advances automatically, but
if you change it by hand your value wins outright — including moving a row backwards.

---

## Privacy

Everything runs locally in your browser. There is no server and no telemetry.

- Google tokens are held by Chrome's identity service (or in extension-local storage
  on the PKCE path) and are never transmitted anywhere but Google.
- Gmail access is **read-only** (`gmail.readonly`). The extension cannot send, delete
  or modify mail. It only fetches messages returned by a search scoped to a company
  you applied to.
- Email bodies are classified in memory and discarded. Only the subject, sender,
  timestamp, classification and thread ID are written to your own spreadsheet.
- The only outbound requests are to Google's APIs — plus your enrichment endpoint,
  if you configure one.

---

## A note on funding data

Stage, valuation and total raised are read off the job page whenever the company states
them — startup postings often do (*"We're a Series B company that raised $50M…"*), and
Wellfound publishes them structurally. **Most postings don't**, so those cells will often
be blank.

There is no free, licensed, generally-available API for private-company funding data, so
JobPlug doesn't bundle one. What it ships instead is the seam: point **Options → Company
enrichment** at any JSON endpoint (a vendor API you have a key for, or your own proxy) and
the gaps fill in automatically, cached for 30 days. Both the popup and the sheet are
editable, so you can also just type them in.

---

## Development

```bash
npm test          # 53 tests — parsing, classification, dedupe, aggregates, Sheets requests
npm run check     # manifest ↔ filesystem consistency, syntax check on every script
npm run pin-id    # pin the extension ID so it survives moving the folder
npm run package   # check, then bundle extension/ into jobplug-extension.zip
```

```
extension/
  manifest.json
  src/
    common/       constants.js · util.js · parse.js       shared by every context
    content/      nethook.js   · adapters.js · detector.js  detection
    background/   service_worker.js · auth.js · sheets.js · gmail.js
                  classifier.js · store.js · sync.js · enrich.js
    popup/        popup.html · popup.js · popup.css
    options/      options.html · options.js · options.css
```

`common/` files are classic scripts that publish onto `globalThis.JAT` — the same file
works as a manifest content script (which cannot be an ES module) and as a side-effect
import in the module service worker.

### Tuning detection

- `constants.js` → `BOARDS` — add an ATS: hostnames, apply-endpoint regexes, mail domains
- `constants.js` → `SUCCESS_PATTERNS` / `APPLY_BUTTON_RE` — confirmation and button copy
- `detector.js` → `WEIGHTS` / `THRESHOLD` — how much evidence is needed before logging
- `classifier.js` → `RULES` — email phrasing per category

If an application slips past detection, right-click the page → **Track this job
application**, or use the popup's **Add** tab (it prefills from the open tab).

---

## Known limits

- **Workday** multi-step flows sometimes submit through a generic endpoint; if a Workday
  application is missed, the right-click fallback catches it.
- Applications submitted **by email** aren't detected — nothing happens in the browser.
- Company domain is inferred by scoring links on the page. When it guesses wrong, Gmail
  matching falls back to company name plus job title, which needs both to agree.
- Gmail matching needs a company name of 3+ characters, or a known domain.
