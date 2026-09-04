import { isTargetTitle } from "./roles";
import { isUsLocation, workplaceType } from "./locations";

export type SourceBoard = { id: string; ats: string; slug: string; companyName: string };
export type CanonicalJob = {
  id: string; canonicalKey: string; title: string; company: string; location: string; workplace: string;
  source: string; externalJobId: string; sourceUrl: string; applyUrl: string; postedAt: string | null;
  discoveredAt: string; lastSeenAt: string; status: string; isSeed: boolean;
};

type Raw = Record<string, unknown>;

// Every connector below is a public JSON endpoint, no credentials and no HTML scraping.
export const enabledAts = ["Ashby", "Greenhouse", "Lever", "SmartRecruiters", "Workable", "Recruitee", "Breezy", "Pinpoint", "Rippling", "BambooHR", "JobScore", "Oracle"];

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

function canonical(source: SourceBoard, id: string, title: string, location: string, applyUrl: string, postedAt: unknown): CanonicalJob {
  const now = new Date().toISOString(), jobKey = key(source, id);
  const cleanTitle = title.replace(/\s+/g, " ").trim(), cleanLocation = location.replace(/\s+/g, " ").trim();
  return { id: jobKey, canonicalKey: jobKey, title: cleanTitle, company: source.companyName, location: cleanLocation, workplace: workplaceType(cleanLocation), source: source.ats, externalJobId: id, sourceUrl: applyUrl, applyUrl, postedAt: iso(postedAt), discoveredAt: now, lastSeenAt: now, status: "New", isSeed: false };
}

function keep(title: string, location: string) {
  return isTargetTitle(title) && isUsLocation(location);
}

async function json<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SaiJobRadar/2.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const joinParts = (...parts: unknown[]) => parts.map(str).map(part => part.trim()).filter(Boolean).join(", ");

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
      return [canonical(source, id, title, location, str(raw.jobUrl) || str(raw.applyUrl) || `https://jobs.ashbyhq.com/${source.slug}`, raw.publishedAt)];
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
      return [canonical(source, id, title, location, str(raw.hostedUrl) || str(raw.applyUrl) || `https://jobs.lever.co/${source.slug}`, raw.createdAt)];
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
      return [canonical({ ...source, companyName: str(raw.company_name) || source.companyName }, id, title, location, str(raw.careers_url) || `https://${source.slug}.recruitee.com/o/${str(raw.slug)}`, raw.published_at)];
    });
  }

  if (source.ats === "Breezy") {
    const data = await json<Raw[]>(`https://${slug}.breezy.hr/json`);
    return data.flatMap(raw => {
      const title = str(raw.name), loc = raw.location as Raw | undefined;
      const location = str(loc?.name) || joinParts(loc?.city, (loc?.state as Raw | undefined)?.name, (loc?.country as Raw | undefined)?.name) || (loc?.is_remote ? "Remote" : "");
      if (!keep(title, location)) return [];
      const id = str(raw.id) || str(raw.friendly_id) || title;
      return [canonical(source, id, title, location, str(raw.url) || `https://${source.slug}.breezy.hr/p/${str(raw.friendly_id) || id}`, raw.published_date)];
    });
  }

  if (source.ats === "Pinpoint") {
    const data = await json<{ data?: Raw[] }>(`https://${slug}.pinpointhq.com/postings.json`);
    return (data.data ?? []).flatMap(raw => {
      const title = str(raw.title) || str(raw.name), loc = raw.location as Raw | undefined;
      const location = str(loc?.name) || joinParts(loc?.city, loc?.province, loc?.country) || (raw.workplace_type === "remote" ? "Remote" : "");
      if (!keep(title, location)) return [];
      const rawUrl = str(raw.url) || str(raw.absolute_url), id = str(raw.id) || str(raw.uuid) || title;
      return [canonical(source, id, title, location, rawUrl || `https://${source.slug}.pinpointhq.com/postings/${id}`, raw.published_at ?? raw.created_at)];
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

  throw new Error(`${source.ats} boards are not supported`);
}
