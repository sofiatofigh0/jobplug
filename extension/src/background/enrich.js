import '../common/constants.js';
import '../common/util.js';
import '../common/parse.js';

const { U } = globalThis.JAT;

/**
 * Optional company-data enrichment.
 *
 * There is no free, licensed, generally-available API for private-company
 * funding and valuation, so JobPlug does not ship a provider. What it ships is
 * the seam: point `enrichEndpoint` at anything that answers with JSON — a
 * vendor API you have a key for, or your own small proxy — and the missing
 * cells get filled. Without it, stage/valuation/raised come from whatever the
 * job page itself states, plus anything you type in.
 */

const CACHE_KEY = 'enrichCache';
const TTL_MS = 30 * 86400000;

async function readCache() {
  const { [CACHE_KEY]: c } = await chrome.storage.local.get(CACHE_KEY);
  return c || {};
}

async function writeCache(key, value) {
  const cache = await readCache();
  cache[key] = { value, at: Date.now() };
  // Keep the cache bounded; drop the oldest entries first.
  const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}

/** Accept the field names the common vendors actually use. */
function normalise(json) {
  if (!json || typeof json !== 'object') return {};
  const src = json.company || json.data || json.organization || json;
  const first = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), src);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  const money = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object') return money(v.value ?? v.amount ?? v.value_usd);
    const n = globalThis.JAT.P.parseMoney(v);
    return n != null && isFinite(n) ? n : null;
  };

  const out = {
    companyStage: U.clean(first('stage', 'funding_stage', 'last_funding_type', 'fundingStage') || ''),
    valuation: money(first('valuation', 'post_money_valuation', 'valuation_usd', 'latest_valuation')),
    totalRaised: money(first('totalRaised', 'total_funding', 'total_funding_usd', 'funding_total', 'total_raised')),
    lastRound: U.clean(first('lastRound', 'last_funding_type', 'latest_round') || ''),
    lastRoundDate: U.clean(first('lastRoundDate', 'last_funding_date', 'latest_round_date') || ''),
    headcount: U.clean(String(first('headcount', 'employee_count', 'employees', 'size', 'employee_range') || '')),
    industry: U.clean(first('industry', 'industries', 'category', 'sector') || ''),
  };
  if (Array.isArray(out.industry)) out.industry = out.industry.join(', ');
  for (const k of Object.keys(out)) if (out[k] === '' || out[k] == null) delete out[k];
  return out;
}

/**
 * @returns {Promise<object>} partial record; `{}` when disabled, cached-empty,
 *          or the provider had nothing.
 */
export async function enrichCompany({ company, domain }, settings) {
  if (!settings.enrichEnabled || !settings.enrichEndpoint) return {};
  const key = (domain || U.normCompany(company || '')).toLowerCase();
  if (!key) return {};

  const cache = await readCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value || {};

  const url = settings.enrichEndpoint
    .replace(/\{domain\}/g, encodeURIComponent(domain || ''))
    .replace(/\{name\}/g, encodeURIComponent(company || ''));

  try {
    const headers = { Accept: 'application/json' };
    if (settings.enrichApiKey) {
      headers['X-API-Key'] = settings.enrichApiKey;
      headers.Authorization = `Bearer ${settings.enrichApiKey}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const value = normalise(await res.json());
    await writeCache(key, value);
    return value;
  } catch (err) {
    console.warn('[JobPlug] enrichment failed for', key, err.message);
    await writeCache(key, {});     // don't hammer a failing endpoint
    return {};
  }
}
