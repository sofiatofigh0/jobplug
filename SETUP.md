# Setup

JobPlug talks to Google Sheets and Gmail as *you*, from your own browser. That means you
need your own OAuth client — about ten minutes, once. Nothing here costs money; both APIs
are free at the volumes this extension uses.

---

## 0. Get the files onto the machine running Chrome

**A Chrome extension cannot be loaded from a remote container.** *Load unpacked* opens a
file picker on the computer running Chrome, and it cannot see a Codespace, a devcontainer,
or an SSH host. Wherever you edit the code, the folder has to exist locally to load it.

Pick whichever applies:

**No tooling at all** — you don't need git, Node, or a terminal to *use* this:

> Download <https://github.com/sofiatofigh0/jobplug/archive/refs/heads/claude/job-app-tracker-extension-dajhwt.zip>,
> unzip it, and use the `extension/` folder inside. Skip to step 1.

**Local clone** — best if you'll be changing code:

```bash
git clone -b claude/job-app-tracker-extension-dajhwt https://github.com/sofiatofigh0/jobplug.git
```

**GitHub Codespaces / remote devcontainer** — edit remotely, run locally:

```bash
npm run pin-id      # once: fixes the extension ID so it survives re-downloading
npm run package     # writes jobplug-extension.zip
```

Right-click `jobplug-extension.zip` in the file explorer → **Download**, unzip it locally,
and load that folder. One file beats downloading a 25-file tree, and `npm run package`
runs the consistency check first so you never download a broken build.

There is **no build step** — the `extension/` folder loads exactly as it is. Node is only
needed for `npm test`, `npm run check`, `npm run pin-id` and `npm run package`.

### Pin the extension ID first if the folder will ever move

Chrome derives an unpacked extension's ID from its folder path. Both OAuth options below
bake that ID in — the Chrome-app client is bound to it, and the PKCE redirect URI contains
it — so moving the folder, or unzipping a fresh download somewhere else, silently breaks
sign-in.

```bash
npm run pin-id
```

This writes a public key into `manifest.json`, which makes the ID a function of that key
instead of the path. It then stays the same wherever you unzip it, on every machine. Commit
the changed `manifest.json` and the ID follows you around. Run it **before** step 2 — the
script prints the ID you'll need there.

**No Node installed?** `openssl` ships with macOS and Linux and does the same job:

```bash
cd path/to/extension                     # the folder containing manifest.json

openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out ../key.pem

# The value to put in manifest.json:
openssl rsa -in ../key.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n'

# The extension ID that key produces:
openssl rsa -in ../key.pem -pubout -outform DER 2>/dev/null \
  | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p'
```

Open `manifest.json` in any text editor and add the base64 string as a top-level `key`,
right after `"version"`:

```json
{
  "manifest_version": 3,
  "name": "JobPlug — Job Application Tracker",
  "version": "1.0.0",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...",
  ...
}
```

Reload the extension. The ID on the card should now match what the second command printed,
and it will stay that way wherever you move the folder. Keep `key.pem` outside the
extension folder so it never ends up in a package.

---

## 1. Load the extension

1. `chrome://extensions` → turn on **Developer mode** (top right)
2. **Load unpacked** → select the `extension/` folder
3. **Move the folder to where it will live permanently, before going further.**
   Chrome derives the extension ID from the folder path, and both OAuth options bake
   that ID in. `~/Downloads` is a bad home — people empty it. Move it now (e.g. to
   `~/Applications/jobplug/` or `~/dev/jobplug/`), then **Remove extension** and
   **Load unpacked** again from the new location. Or pin the ID — see below.
4. Note the **extension ID**. It's the 32-letter string on the extension's card, and
   also in the address bar when you click **Details**:
   `chrome://extensions/?id=`**`<this part>`**. You need it in step 5.

### Finding JobPlug's own settings

Two ways, and neither is obvious the first time:

- On the extension's **Details** page, scroll to **Extension options** and click it.
- Or turn on **Pin to toolbar** on that same page, then click the JobPlug icon in the
  toolbar and hit the **⚙** in the popup header.

That settings page is where *Sign-in method*, **Connect Google**, resume versions and
everything else lives.

---

## 2. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/projectcreate>
2. Name it anything (`jobplug` is fine) → **Create**
3. Make sure the new project is selected in the picker at the top

---

## 3. Enable the two APIs

Search "Google Sheets API" and "Gmail API" in the console, or go straight there:

- <https://console.cloud.google.com/apis/library/sheets.googleapis.com> → **Enable**
- <https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**

---

## 4. Configure the consent screen

> **The old "OAuth consent screen" wizard no longer exists.** Google replaced it with
> **Google Auth Platform**, which splits the same settings across four separate left-nav
> pages. There is **no scopes step in the app-creation flow** — scopes moved to their own
> page called **Data Access**. If you went looking for "Add or remove scopes" during setup
> and couldn't find it, that's why.

| Setting | Page | Direct link |
|---|---|---|
| App name, support email | **Branding** | <https://console.cloud.google.com/auth/branding> |
| Internal/External, **test users** | **Audience** | <https://console.cloud.google.com/auth/audience> |
| **Scopes** | **Data Access** | <https://console.cloud.google.com/auth/scopes> |
| OAuth client IDs | **Clients** | <https://console.cloud.google.com/auth/clients> |

**a. Create the app** — <https://console.cloud.google.com/auth/overview>

Fill in app name, your email as user support contact, **Audience: External**, your email
as the developer contact, accept the policy. It will not ask you about scopes. That's
expected.

**b. Add yourself as a test user** — **Audience** → *Test users* → **Add users** → your
own Gmail address → **Save**.

This step is the one that actually gates access. Leave publishing status as **Testing**.

**c. Add the scopes** — **Data Access** → **Add or remove scopes**.

The picker is paginated over hundreds of scopes, so use the *Filter* box and paste each
one in full rather than scrolling:

```
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/userinfo.email
```

Tick each, then **Update** at the bottom of the panel, then **Save** on the Data Access
page. `spreadsheets` lands under *Sensitive scopes* and `gmail.readonly` under
*Restricted scopes* — that's correct, not an error.

If a scope doesn't appear in the picker, its API isn't enabled yet. Go back to step 3.

`gmail.readonly` being restricted triggers a warning about verification. **Ignore it.**
Verification only matters to publish an app for other people; in *Testing* with yourself
as a test user, your own account works.

> **If you still can't find Data Access:** the extension requests its scopes at runtime —
> they're in `manifest.json` under `oauth2.scopes` and in the authorization request itself
> — so the consent prompt is driven by what the code asks for, not by this list. Listing
> them here is the correct thing to do, but if the UI is fighting you, go ahead and try
> **Connect Google**; the consent screen should still ask for Sheets and Gmail. Being a
> **test user** is the part you cannot skip.

> **Note on Testing mode:** refresh tokens expire after 7 days in Testing. On Chrome
> identity sign-in (option A below) this is invisible — Chrome re-prompts silently. On
> the PKCE path you may need to click **Connect Google** again about weekly. To stop that,
> set the consent screen to *In production*; for a single-user app that's safe, Google just
> shows an "unverified app" interstitial you click through once.

---

## 5. Create the OAuth client

Pick **one** of these. Option A is smoother; option B works everywhere.

### Option A — Chrome App client (recommended, Chrome only)

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** →
   **OAuth client ID**
2. Application type: **Chrome app**
3. **Item ID**: the extension ID from step 1
4. Copy the client ID it gives you
5. Open `extension/manifest.json` and replace the placeholder:

   ```json
   "oauth2": {
     "client_id": "YOUR-CLIENT-ID.apps.googleusercontent.com",
     "scopes": [ ... ]
   }
   ```

6. Back on `chrome://extensions`, click **Reload** on the JobPlug card
7. In JobPlug's settings, leave **Sign-in method** on *Chrome identity*

**Keeping the extension ID stable.** If you skipped `npm run pin-id` in step 0, the ID is
derived from the folder path and changes if you move the folder — at which point this OAuth
client stops matching. Run `npm run pin-id` and reload the extension to fix it permanently.

### Option B — Browser redirect / PKCE (Brave, Edge, or if you'd rather not pin the ID)

1. **Create credentials** → **OAuth client ID** → Application type: **Web application**
2. Under **Authorized redirect URIs**, add:

   ```
   https://<your-extension-id>.chromiumapp.org/
   ```

   JobPlug's settings page prints this exact URL — copy it from there, trailing slash included.
3. Copy the client ID, and the client secret if one is issued
4. In JobPlug's settings: **Sign-in method** → *Browser redirect / PKCE*, paste both, **Save settings**

---

## 6. Connect

1. Open JobPlug's settings (the ⚙ in the popup, or the extension's *Options*)
2. **Connect Google** → pick your account → grant both permissions
3. Google will warn the app is unverified — **Advanced** → *Go to … (unsafe)*.
   It's your own client ID, running your own copy of the code.
4. A spreadsheet is created and opens in a new tab
5. Click **Test Gmail access** to confirm the second scope actually took

---

## 7. Set up your resume versions

This is the step that makes the dashboard worth reading.

Settings → **Resume versions** → add a mapping per resume file:

| filename contains | show as |
|---|---|
| `backend_v3` | Backend v3 |
| `sofia_pm` | Product Manager |
| `2026_generalist` | Generalist |

Matching is case-insensitive substring, or a regular expression if you'd rather. Without
mappings the raw filename is used, which still works — it's just noisier when you're
comparing which version gets replies.

---

## Verifying it works

1. Apply to any job on Greenhouse, Lever, Ashby or LinkedIn
2. A desktop notification should appear within a second or two of submitting
3. Open the popup — the application is in **Applications**
4. Click **Sheet** — the row is there

If nothing appears:

- **Reload the extension** and reload the job page. Content scripts are only injected into
  pages loaded *after* the extension was installed or reloaded.
- Open the page's devtools console and look for `[JobPlug]` warnings.
- Inspect the service worker: `chrome://extensions` → JobPlug → **service worker** →
  Console. Auth and Sheets errors surface there.
- Use the popup's **Add** tab or right-click → **Track this job application** as a fallback,
  and open an issue with the site — an adapter is usually a few lines.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Can't find where to add scopes | Google replaced the OAuth consent screen wizard with **Google Auth Platform**. Scopes are now on their own page: **Data Access** (<https://console.cloud.google.com/auth/scopes>). Test users moved to **Audience**. |
| `bad client id` on connect | The manifest `client_id` doesn't match the extension ID, or you're on option A with a Web-application client. Re-check step 5. |
| `redirect_uri_mismatch` | Option B, and the URI in Cloud Console doesn't exactly match the one printed in settings — usually a missing trailing slash. |
| Connect succeeds, Sheets fails | The Sheets API isn't enabled on the project, or you connected before enabling it. Enable it, then Disconnect and reconnect. |
| **Test Gmail access** fails | `gmail.readonly` wasn't added to the consent screen, or wasn't granted at the consent prompt. Re-add it, then Disconnect and reconnect so a fresh grant is requested. |
| Statuses never move off *Applied* | Gmail watching is off, or the company domain was guessed wrong. Check the **Email Log** tab — if the mail isn't there at all, it's a matching problem; fix the Company Domain cell in the Applications tab and it will match next sync. |
| Same job logged twice | Two postings whose company or title differ in a way that survives normalisation. Delete one in the popup; it's removed from the sheet too. |
| Nothing detected on one site | That site's apply flow doesn't match any known pattern. Use the right-click fallback, and see *Tuning detection* in the README. |
