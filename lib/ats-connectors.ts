import { isTargetTitle } from "./roles";
import { isUsLocation, workplaceType } from "./locations";

export type SourceBoard = { id: string; ats: string; slug: string; companyName: string };
export type CanonicalJob = {
  id: string; canonicalKey: string; title: string; company: string; location: string; workplace: string;
  source: string; externalJobId: string; sourceUrl: string; applyUrl: string; salary: string | null; postedAt: string | null;
  discoveredAt: string; lastSeenAt: string; status: string; isSeed: boolean;
  /** Description text when the board payload carries it (Ashby, Lever, Pinpoint, Recruitee, Breezy). Not stored as-is. */
  jdText?: string;
};

type Raw = Record<string, unknown>;


/** Boards an aggregator connector learned about while keying its rows; the pipeline drains this after each scan. */
export type DiscoveredBoard = SourceBoard & { boardUrl: string; origin: string };
const discoveredBoards = new Map<string, DiscoveredBoard>();
export function drainDiscoveredBoards(): DiscoveredBoard[] {
  const out = [...discoveredBoards.values()];
  discoveredBoards.clear();
  return out;
}

/**
 * jobs.workable.com names the company but not its apply.workable.com account. Guess the account slug from the company
 * name and website domain, and trust a guess only when that account's own listing carries the job we are holding
 * (Workable answers 200 with an empty list for real-but-unrelated accounts, 404 for unknown ones). Cached per isolate.
 */
const workableAccounts = new Map<string, { slug: string; jobs: Map<string, string> } | null>();
async function resolveWorkableAccount(company: string, website: string, title: string, allowFetch: boolean) {
  const wanted = title.toLowerCase();
  let entry = workableAccounts.get(company), attempted = false;
  if (entry === undefined) {
    if (!allowFetch) return { attempted, slug: null, shortcode: null };
    attempted = true; entry = null;
    const base = company.toLowerCase().replace(/[.,'&]/g, " ").replace(/\b(?:inc|llc|corp|corporation|ltd|co|group)\b/g, "").trim();
    const domain = website.replace(/^https?:\/\/(?:www\.)?/i, "").split(/[/.]/)[0].toLowerCase();
    const guesses = [...new Set([base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), base.replace(/[^a-z0-9]/g, ""), domain].filter(guess => guess.length >= 3))];
    for (const slug of guesses) {
      try {
        const data = await json<{ jobs?: Raw[] }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
        const list = data.jobs ?? [];
        if (!list.length) continue;
        const candidate = { slug, jobs: new Map(list.map(job => [str(job.title).toLowerCase(), str(job.shortcode) || str(job.code)])) };
        if (candidate.jobs.has(wanted)) { entry = candidate; break; }
      } catch { /* 404 or timeout: not this slug */ }
    }
    workableAccounts.set(company, entry);
  }
  return { attempted, slug: entry?.slug ?? null, shortcode: entry?.jobs.get(wanted) ?? null };
}

// Every connector below is a public JSON endpoint, no credentials and no HTML scraping.
export const enabledAts = ["Ashby", "Greenhouse", "Lever", "SmartRecruiters", "Workable", "Recruitee", "Breezy", "Pinpoint", "Rippling", "BambooHR", "JobScore", "Oracle", "Gem", "Amazon", "AI Jobs", "Workable Search"];

export function boardKeyPrefix(source: SourceBoard) {
  return `${source.ats}:${source.slug}:`.toLowerCase().replace(/[^a-z0-9:]+/g, "-");
}

function key(source: SourceBoard, id: string) {
  return `${boardKeyPrefix(source)}${id}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-");
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonical(source: SourceBoard, id: string, title: string, location: string, applyUrl: string, postedAt: unknown, salary: string | null = null): CanonicalJob {
  const now = new Date().toISOString(), jobKey = key(source, id);
  const cleanTitle = title.replace(/\s+/g, " ").trim(), cleanLocation = location.replace(/\s+/g, " ").trim();
  return { id: jobKey, canonicalKey: jobKey, title: cleanTitle, company: source.companyName, location: cleanLocation, workplace: workplaceType(cleanLocation), source: source.ats, externalJobId: id, sourceUrl: applyUrl, applyUrl, salary, postedAt: iso(postedAt), discoveredAt: now, lastSeenAt: now, status: "New", isSeed: false };
}

function keep(title: string, location: string) {
  return isTargetTitle(title) && isUsLocation(location);
}

async function json<T>(url: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const init: RequestInit = { headers: { accept: "application/json", "user-agent": "SaiJobRadar/2.0" }, signal: controller.signal };
    if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body), headers: { ...init.headers, "content-type": "application/json" } });
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const joinParts = (...parts: unknown[]) => parts.map(str).map(part => part.trim()).filter(Boolean).join(", ");

/**
 * When an aggregator hands us a link into a board we read directly, key the job exactly as that connector would, so the
 * two sources merge into one row instead of duplicating it. Returns null for hosts we do not read.
 */
function atsKeyFromUrl(rawUrl: string): { id: string; ats: string; slug: string; jobId: string } | null {
  try {
    const url = new URL(rawUrl), host = url.hostname.toLowerCase(), parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    let ats = "", slug = "", jobId = "";
    if (/(^|\.)greenhouse\.io$/.test(host) && parts[1] === "jobs" && parts[2]) [ats, slug, jobId] = ["Greenhouse", parts[0], parts[2]];
    else if (host === "jobs.ashbyhq.com" && parts[1]) [ats, slug, jobId] = ["Ashby", parts[0], parts[1]];
    else if (host === "jobs.lever.co" && parts[1]) [ats, slug, jobId] = ["Lever", parts[0], parts[1]];
    else if (host === "jobs.gem.com" && parts[1] && parts[0] !== "source") [ats, slug, jobId] = ["Gem", parts[0], parts[1]];
    else if (/(^|\.)amazon\.jobs$/.test(host) && parts[1] === "jobs" && parts[2]) [ats, slug, jobId] = ["Amazon", "us", parts[2]];
    else return null;
    if (!/^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27}|am9icG9zdD[A-Za-z0-9_-]{10,})$/i.test(jobId)) return null;
    return { id: `${ats}:${slug}`.toLowerCase(), ats, slug, jobId };
  } catch {
    return null;
  }
}

/** Greenhouse pay_input_ranges → "$120,000–$150,000" (USD only; other currencies are left out rather than mislabeled). */
function formatPayRanges(ranges: unknown): string | null {
  if (!Array.isArray(ranges)) return null;
  const usd = (ranges as Raw[]).filter(range => str(range.currency_type).toUpperCase() === "USD" && (range.min_cents || range.max_cents));
  if (!usd.length) return null;
  const dollars = (cents: unknown) => `$${Math.round(Number(cents) / 100).toLocaleString("en-US")}`;
  const min = Math.min(...usd.map(range => Number(range.min_cents || range.max_cents)));
  const max = Math.max(...usd.map(range => Number(range.max_cents || range.min_cents)));
  return min === max ? dollars(min) : `${dollars(min)}–${dollars(max)}`;
}

export type JobDetails = { text: string | null; salary?: string | null; postedAt?: string | null };

/**
 * Fetch one job's description (plus, where the ATS exposes them, its pay range and true first-published date) for
 * boards whose list payload lacks them. `text` is null when the ATS has no per-job endpoint we can read (Rippling,
 * Oracle, aggregator rows) or the job is gone. Used by the fit scorer, at most once per job.
 */
export async function fetchJobDetails(job: { source: string; applyUrl: string; externalJobId: string | null }): Promise<JobDetails> {
  try {
    const url = new URL(job.applyUrl), parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    if (job.source === "Greenhouse" && /greenhouse\.io$/.test(url.hostname) && parts[1] === "jobs" && parts[2]) {
      // The list endpoint only carries updated_at; the per-job one has first_published and (opt-in) pay ranges.
      const data = await json<{ content?: string; first_published?: string; pay_input_ranges?: unknown }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}?pay_transparency=true`);
      return { text: str(data.content) || null, salary: formatPayRanges(data.pay_input_ranges), postedAt: iso(data.first_published) };
    }
    if (job.source === "Workable" && url.hostname === "apply.workable.com" && parts[1] === "j" && parts[2]) {
      const data = await json<{ description?: string; requirements?: string }>(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}`);
      return { text: [str(data.description), str(data.requirements)].filter(Boolean).join("\n") || null };
    }
    if (job.source === "SmartRecruiters" && url.hostname === "jobs.smartrecruiters.com" && parts[0] && parts[1]) {
      const data = await json<{ jobAd?: { sections?: Record<string, { text?: string }> } }>(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(parts[0])}/postings/${encodeURIComponent(parts[1].split("-")[0])}`);
      const sections = data.jobAd?.sections ?? {};
      return { text: [sections.jobDescription?.text, sections.qualifications?.text, sections.additionalInformation?.text].map(str).filter(Boolean).join("\n") || null };
    }
    if (job.source === "BambooHR" && /\.bamboohr\.com$/.test(url.hostname) && parts[0] === "careers" && parts[1]) {
      const data = await json<{ result?: { jobOpening?: { description?: string } } }>(`https://${url.hostname}/careers/${encodeURIComponent(parts[1])}/detail`);
      return { text: str(data.result?.jobOpening?.description) || null };
    }
    return { text: null };
  } catch {
    return { text: null };
  }
}

export async function fetchBoardJobs(source: SourceBoard): Promise<CanonicalJob[]> {
  const slug = encodeURIComponent(source.slug.trim());

  if (source.ats === "Ashby") {
    const data = await json<{ jobs?: Raw[] }>(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`);
    return (data.jobs ?? []).flatMap(raw => {
      if (raw.isListed === false) return [];
      const title = str(raw.title);
      const secondary = (raw.secondaryLocations as Raw[] | undefined ?? []).map(item => str(item.location)).filter(Boolean);
      const location = [str(raw.location), ...secondary].filter(Boolean).join("; ") || (raw.isRemote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.jobUrl) || title;
      return [{ ...canonical(source, id, title, location, str(raw.jobUrl) || str(raw.applyUrl) || `https://jobs.ashbyhq.com/${source.slug}`, raw.publishedAt), jdText: str(raw.descriptionPlain) || str(raw.descriptionHtml) || undefined }];
    });
  }

  if (source.ats === "Greenhouse") {
    const data = await json<{ jobs?: Raw[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (data.jobs ?? []).flatMap(raw => {
      const title = str(raw.title), location = str((raw.location as Raw | undefined)?.name);
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.absolute_url) || title;
      return [canonical(source, id, title, location, str(raw.absolute_url) || `https://job-boards.greenhouse.io/${source.slug}`, raw.first_published ?? raw.updated_at)];
    });
  }

  if (source.ats === "Lever") {
    const data = await json<Raw[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return data.flatMap(raw => {
      const title = str(raw.text), categories = raw.categories as Raw | undefined;
      const location = [str(categories?.location), ...((raw.categories as Raw | undefined)?.allLocations as string[] | undefined ?? [])].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join("; ") || (raw.workplaceType === "remote" ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.hostedUrl) || title;
      const lists = (raw.lists as Raw[] | undefined ?? []).map(item => `${str(item.text)}\n${str(item.content)}`).join("\n");
      return [{ ...canonical(source, id, title, location, str(raw.hostedUrl) || str(raw.applyUrl) || `https://jobs.lever.co/${source.slug}`, raw.createdAt), jdText: [str(raw.descriptionPlain) || str(raw.description), lists, str(raw.additionalPlain) || str(raw.additional)].filter(Boolean).join("\n") || undefined }];
    });
  }

  if (source.ats === "SmartRecruiters") {
    const data = await json<{ content?: Raw[] }>(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
    return (data.content ?? []).flatMap(raw => {
      const title = str(raw.name), loc = raw.location as Raw | undefined;
      const location = joinParts(loc?.city, loc?.region, loc?.country === "us" ? "United States" : loc?.country) || (loc?.remote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || title;
      return [canonical(source, id, title, location, `https://jobs.smartrecruiters.com/${source.slug}/${id}`, raw.releasedDate)];
    });
  }

  if (source.ats === "Workable") {
    const data = await json<{ jobs?: Raw[] }>(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
    return (data.jobs ?? []).flatMap(raw => {
      const title = str(raw.title), locations = raw.locations as Raw[] | undefined;
      const location = (locations ?? []).map(loc => joinParts(loc.city, loc.region, loc.countryCode === "US" ? "United States" : loc.country ?? loc.countryCode)).filter(Boolean).join("; ") || joinParts(raw.city, raw.state, raw.country) || (raw.remote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.shortcode) || str(raw.code) || title;
      return [canonical(source, id, title, location, str(raw.url) || `https://apply.workable.com/${source.slug}/j/${id}`, raw.published_on ?? raw.published)];
    });
  }

  if (source.ats === "Recruitee") {
    const data = await json<{ offers?: Raw[] }>(`https://${slug}.recruitee.com/api/offers/`);
    return (data.offers ?? []).flatMap(raw => {
      const title = str(raw.title), country = raw.country_code === "US" ? "United States" : str(raw.country_code);
      const location = joinParts(raw.city, raw.state_code, country) || (raw.remote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.slug) || title;
      return [{ ...canonical({ ...source, companyName: str(raw.company_name) || source.companyName }, id, title, location, str(raw.careers_url) || `https://${source.slug}.recruitee.com/o/${str(raw.slug)}`, raw.published_at), jdText: [str(raw.description), str(raw.requirements)].filter(Boolean).join("\n") || undefined }];
    });
  }

  if (source.ats === "Breezy") {
    const data = await json<Raw[]>(`https://${slug}.breezy.hr/json`);
    return data.flatMap(raw => {
      const title = str(raw.name), loc = raw.location as Raw | undefined;
      const location = str(loc?.name) || joinParts(loc?.city, (loc?.state as Raw | undefined)?.name, (loc?.country as Raw | undefined)?.name) || (loc?.is_remote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.friendly_id) || title;
      return [{ ...canonical(source, id, title, location, str(raw.url) || `https://${source.slug}.breezy.hr/p/${str(raw.friendly_id) || id}`, raw.published_date), jdText: str(raw.description) || undefined }];
    });
  }

  if (source.ats === "Pinpoint") {
    const data = await json<{ data?: Raw[] }>(`https://${slug}.pinpointhq.com/postings.json`);
    return (data.data ?? []).flatMap(raw => {
      const title = str(raw.title) || str(raw.name), loc = raw.location as Raw | undefined;
      const location = str(loc?.name) || joinParts(loc?.city, loc?.province, loc?.country) || (raw.workplace_type === "remote" ? "Remote" : "");
      if (!keep(title, location)) return [];
      const rawUrl = str(raw.url) || str(raw.absolute_url), id = str(raw.id) || str(raw.uuid) || title;
      return [{ ...canonical(source, id, title, location, rawUrl || `https://${source.slug}.pinpointhq.com/postings/${id}`, raw.published_at ?? raw.created_at), jdText: str(raw.description) || undefined }];
    });
  }

  if (source.ats === "Rippling") {
    const data = await json<{ items?: Raw[] } | Raw[]>(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`);
    const items = Array.isArray(data) ? data : data.items ?? [];
    return items.flatMap(raw => {
      const title = str(raw.name) || str(raw.title);
      const locations = raw.locations as Raw[] | undefined;
      const location = (locations ?? []).map(loc => str(loc.name) || joinParts(loc.city, loc.state, loc.country)).filter(Boolean).join("; ") || str((raw.workLocation as Raw | undefined)?.label) || str(raw.location) || (raw.isRemote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.uuid) || title;
      return [canonical(source, id, title, location, str(raw.url) || str(raw.jobUrl) || `https://ats.rippling.com/${source.slug}/jobs/${id}`, raw.createdAt ?? raw.publishedAt)];
    });
  }

  if (source.ats === "BambooHR") {
    // Public list used by the hosted careers page. Non-customers answer with the marketing site (HTML), which fails JSON parsing → invalid board.
    const data = await json<{ result?: Raw[] }>(`https://${slug}.bamboohr.com/careers/list`);
    return (data.result ?? []).flatMap(raw => {
      const title = str(raw.jobOpeningName) || str(raw.title), loc = raw.location as Raw | undefined, ats = raw.atsLocation as Raw | undefined;
      const country = str(ats?.country);
      const location = joinParts(loc?.city ?? ats?.city, loc?.state ?? ats?.state ?? ats?.province, /^(US|USA|United States)$/i.test(country) ? "United States" : country)
        || (raw.isRemote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || title;
      // The list carries no posting date; the feed falls back to when the radar first saw the job.
      return [canonical(source, id, title, location, `https://${source.slug}.bamboohr.com/careers/${id}`, raw.datePosted ?? null)];
    });
  }

  if (source.ats === "JobScore") {
    const data = await json<{ company_name?: string; jobs?: Raw[] }>(`https://careers.jobscore.com/jobs/${slug}/feed.json`);
    const board = { ...source, companyName: str(data.company_name) || source.companyName };
    return (data.jobs ?? []).flatMap(raw => {
      const title = str(raw.title);
      const location = joinParts(raw.city, raw.state, raw.country === "US" ? "United States" : raw.country) || str(raw.location);
      if (!keep(title, location)) return [];
      const id = str(raw.id) || title;
      return [canonical(board, id, title, location, str(raw.detail_url).replace(/\?ref=rss.*$/, "") || `https://careers.jobscore.com/careers/${source.slug}/jobs/${id}`, raw.opened_date ?? raw.last_updated_date)];
    });
  }

  if (source.ats === "Oracle") {
    // Oracle Recruiting Cloud (HCM). Slug is "<host>--<site>", e.g. "jpmc.fa.oraclecloud.com--CX_1001" or a customer
    // domain such as "careers.honeywell.com--Honeywell". The candidate-experience REST API is public and returns the
    // newest 100 requisitions; the feed only shows the last 24 hours, so that is plenty.
    const [host, site = "CX_1"] = source.slug.split("--");
    if (!host) throw new Error("Oracle slug must be host--site");
    const data = await json<{ items?: Array<{ requisitionList?: Raw[] }> }>(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${encodeURIComponent(site)},limit=100,sortBy=POSTING_DATES_DESC`,
    );
    const sitePath = /oraclecloud\.com$/i.test(host) ? `https://${host}/hcmUI/CandidateExperience/en/sites/${site}` : `https://${host}/en/sites/${site}`;
    return (data.items?.[0]?.requisitionList ?? []).flatMap(raw => {
      const title = str(raw.Title);
      const secondary = (raw.secondaryLocations as Raw[] | undefined ?? []).map(item => str(item.Name)).filter(Boolean);
      const location = [str(raw.PrimaryLocation), ...secondary].filter(Boolean).join("; ") || (raw.PrimaryLocationCountry === "US" ? "United States" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.Id) || title;
      return [canonical(source, id, title, location, `${sitePath}/job/${id}`, raw.PostedDate)];
    });
  }

  if (source.ats === "Workable Search") {
    // jobs.workable.com is Workable's own cross-company job search; its JSON API is public. Keyword + "United States" +
    // day_range lists every Workable-hosted US posting from the last two days, including companies whose board is not
    // in the catalog. When the company's account slug can be confirmed the row is keyed exactly like the Workable board
    // connector (so the two merge) and the board is queued for the catalog; otherwise the row stands on its own with
    // the jobs.workable.com link. Account lookups are capped per scan to stay well inside the subrequest budget.
    const queries = ["data engineer", "data scientist", "machine learning engineer", "analytics engineer", "data analyst", "business intelligence", "ai engineer", "data platform"];
    const seen = new Set<string>();
    const out: CanonicalJob[] = [];
    let lookups = 0;
    for (const query of queries) {
      let pageToken = "";
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ query, location: "United States", day_range: "2" });
        if (pageToken) params.set("pageToken", pageToken);
        const data = await json<{ jobs?: Raw[]; nextPageToken?: string }>(`https://jobs.workable.com/api/v1/jobs?${params}`);
        for (const raw of data.jobs ?? []) {
          const viewId = str(raw.url).match(/\/view\/([^/?#]+)/)?.[1] || str(raw.id);
          if (!viewId || seen.has(viewId)) continue;
          seen.add(viewId);
          const title = str(raw.title);
          const places = (raw.locations as unknown[] | undefined ?? []).map(str).map(place => (/telecommute/i.test(place) ? "Remote" : place)).filter(Boolean);
          const location = places.join("; ") || (str(raw.workplace) === "remote" ? "Remote" : str(raw.location));
          if (!keep(title, location)) continue;
          const company = raw.company as Raw | undefined;
          const companyName = str(company?.title) || source.companyName;
          const jdText = [str(raw.description), str(raw.requirementsSection)].filter(Boolean).join("\n").replace(/<[^>]+>/g, " ") || undefined;
          const account = await resolveWorkableAccount(companyName, str(company?.website), title, lookups < 30);
          if (account.attempted) lookups++;
          if (account.slug && account.shortcode) {
            const board: SourceBoard = { id: `workable:${account.slug}`, ats: "Workable", slug: account.slug, companyName };
            discoveredBoards.set(board.id, { ...board, boardUrl: `https://apply.workable.com/${account.slug}/`, origin: "workable-search" });
            out.push({ ...canonical(board, account.shortcode, title, location, `https://apply.workable.com/${account.slug}/j/${account.shortcode}/`, raw.created), jdText });
          } else {
            out.push({ ...canonical({ ...source, companyName }, viewId, title, location, str(raw.url), raw.created), jdText });
          }
        }
        pageToken = str(data.nextPageToken);
        if (!pageToken) break;
      }
    }
    return out;
  }

  if (source.ats === "Gem") {
    // Gem (gem.com ATS) hosts boards at jobs.gem.com/<slug>. The board page reads a public GraphQL endpoint; the same
    // query works without a session. No posting date is exposed, so rows carry discovered_at as their age.
    const query = `query JobBoardList($boardId: String!) { oatsExternalJobPostings(boardId: $boardId) { jobPostings { extId title locations { name city isoCountry isRemote } job { locationType } } } jobBoardExternal(vanityUrlPath: $boardId) { teamDisplayName } }`;
    type GemLocation = { name?: string; city?: string; isoCountry?: string; isRemote?: boolean };
    type GemPosting = { extId?: string; title?: string; locations?: GemLocation[]; job?: { locationType?: string } };
    const data = await json<{ data?: { oatsExternalJobPostings?: { jobPostings?: GemPosting[] } | null; jobBoardExternal?: { teamDisplayName?: string } | null }; errors?: Array<{ message?: string }> }>(
      "https://jobs.gem.com/api/public/graphql", { operationName: "JobBoardList", query, variables: { boardId: source.slug } },
    );
    if (!data.data?.jobBoardExternal) throw new Error(data.errors?.[0]?.message || "HTTP 404 (no such Gem board)");
    const board = { ...source, companyName: str(data.data.jobBoardExternal.teamDisplayName) || source.companyName };
    return (data.data.oatsExternalJobPostings?.jobPostings ?? []).flatMap(raw => {
      const title = str(raw.title);
      const places = (raw.locations ?? []).map(loc => (loc.isRemote ? "Remote" : joinParts(loc.city || loc.name, loc.isoCountry === "USA" ? "United States" : loc.isoCountry))).filter(Boolean);
      const location = [...new Set(places)].join("; ") || (raw.job?.locationType === "REMOTE" ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.extId) || title;
      return [canonical(board, id, title, location, `https://jobs.gem.com/${source.slug}/${id}`, null)];
    });
  }

  if (source.ats === "Amazon") {
    // amazon.jobs exposes the same JSON its search page uses. Newest-first keyword searches over the US, stopped at the
    // 48-hour mark like the other aggregators; the payload carries the description and qualifications, so no per-job
    // fetch is needed. Interns and managers are dropped up front. Rows are keyed amazon:us:<icims id>, which is what
    // atsKeyFromUrl produces for amazon.jobs links from other aggregators, so they merge.
    const queries = ["data engineer", "business intelligence engineer", "data scientist", "machine learning engineer", "analytics engineer", "applied scientist", "software engineer data"];
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const seen = new Set<string>();
    const out: CanonicalJob[] = [];
    const strip = (value: unknown) => str(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    for (const query of queries) {
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ base_query: query, country: "USA", result_limit: "100", offset: String(page * 100), sort: "recent" });
        const data = await json<{ jobs?: Raw[] }>(`https://www.amazon.jobs/en/search.json?${params}`);
        const rows = data.jobs ?? [];
        if (!rows.length) break;
        let stale = false;
        for (const raw of rows) {
          const postedAt = iso(str(raw.posted_date).replace(/\s+/g, " "));
          if (postedAt && new Date(postedAt).getTime() < cutoff) { stale = true; continue; }
          const id = str(raw.id_icims) || str(raw.id);
          if (!id || seen.has(id) || raw.is_intern === true || raw.is_manager === true) continue;
          seen.add(id);
          const title = str(raw.title).replace(/\s+/g, " ").trim();
          const location = str(raw.normalized_location).replace(/,\s*USA$/i, ", United States") || joinParts(raw.city, raw.state, "United States");
          if (!keep(title, location)) continue;
          const board: SourceBoard = { ...source, companyName: str(raw.company_name) || "Amazon" };
          const jdText = [strip(raw.description), strip(raw.basic_qualifications), strip(raw.preferred_qualifications)].filter(Boolean).join("\n") || undefined;
          out.push({ ...canonical(board, id, title, location, `https://www.amazon.jobs${str(raw.job_path)}`, postedAt), jdText });
        }
        if (stale) break;
      }
    }
    return out;
  }

  if (source.ats === "AI Jobs") {
    // artificialintelligencejobs.co reads 260+ companies' own career pages; its free API lists US roles newest first,
    // 200 per page, about a quarter of them with a salary range. Rows that link into a Greenhouse/Ashby/Lever board are
    // keyed like that connector's rows (merging, and adding salary); the rest — Amazon, company career sites — become
    // "AI Jobs" rows of their own. Workday links are skipped by request.
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const out: CanonicalJob[] = [];
    for (let page = 0; page < 20; page++) {
      const data = await json<{ jobs?: Raw[] }>(`https://artificialintelligencejobs.co/api/jobs?region=us&limit=200&offset=${page * 200}`);
      const rows = data.jobs ?? [];
      if (!rows.length) break;
      let stale = false;
      for (const raw of rows) {
        const postedAt = iso(raw.posted);
        if (postedAt && new Date(postedAt).getTime() < cutoff) { stale = true; continue; }
        const title = str(raw.title), location = str(raw.location) || (raw.remote ? "Remote" : "");
        if (!keep(title, location)) continue;
        const applyUrl = str(raw.apply_url) || str(raw.url);
        if (!applyUrl || /myworkdayjobs\.com/i.test(applyUrl)) continue;
        const mapped = atsKeyFromUrl(applyUrl);
        const board: SourceBoard = mapped ? { id: mapped.id, ats: mapped.ats, slug: mapped.slug, companyName: str(raw.company) || mapped.slug } : { ...source, companyName: str(raw.company) || source.companyName };
        // A listing on a Greenhouse/Ashby/Lever board we do not read yet is also a new company: queue the board.
        if (mapped) discoveredBoards.set(board.id, { ...board, boardUrl: applyUrl.replace(/\/[^/]+\/?$/, ""), origin: "aijobs" });
        out.push(canonical(board, mapped ? mapped.jobId : applyUrl.replace(/^https?:\/\//, ""), title, location, applyUrl, raw.posted, str(raw.salary) || null));
      }
      if (stale) break;
    }
    return out;
  }

  throw new Error(`${source.ats} boards are not supported`);
}
