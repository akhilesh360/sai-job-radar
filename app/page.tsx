"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { classifyRole, roleFamilies, seniority } from "../lib/roles";

type Status = "New" | "Saved" | "Applied" | "Interview" | "Rejected" | "Archived" | "Closed";
type Job = {
  id: string; title: string; company: string; location: string; workplace: "Remote" | "Hybrid" | "Onsite" | "Unknown";
  source: string; salary: string | null; postedAt: string | null; discoveredAt: string; lastSeenAt: string; applyUrl: string; status: Status;
  h1b: { name: string; approvals: number; fiscalYear: number; exact: boolean; lcaLatestFy: number | null } | null;
  fitScore: number | null; fitReason: string | null;
  jdSkills: string | null; jdYears: number | null; jdFlags: string | null;
};
type SourceStats = {
  total: number; active: number; pending: number; invalid: number; errored: number; seedCatalogSize: number; catalogOffset: number;
  catalogComplete: boolean; lastFullScanAt: string | null; lastScheduledRunAt: string | null; oldestScanAt: string | null;
  discoveryConfigured: boolean; discoveryIntervalHours: number; creditsPerDiscoveryRun: number; lastDiscoveryAt: string | null; lastDiscoveryError: string | null; discoveredBoards: number; serperCreditsUsed: number;
};
type DiscoveryResult = {
  configured: boolean; queries: number; results: number; newSources: number; bumpedBoards: number; unverifiedJobs: number;
  failed: number; lastError?: string; creditsUsedTotal?: number; finishedAt: string;
};

// Credits in your Serper account when this dashboard started counting; used for the low-credit warning.
const SERPER_CREDITS_BOUGHT = 48000;
const statuses: Status[] = ["New", "Saved", "Applied", "Interview", "Rejected", "Archived", "Closed"];
const closedStatuses: Status[] = ["Archived", "Rejected", "Closed"];
const recencyHours: Record<string, number> = { "1 hour": 1, "6 hours": 6, "12 hours": 12, "24 hours": 24 };

function relativeTime(iso: string) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Icon({ name }: { name: "radar" | "search" | "refresh" | "mail" | "external" | "stop" }) {
  const paths = {
    radar: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v8l5 3" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9a7 7 0 0 0-12-2L4 11M5.5 15a7 7 0 0 0 12 2l2.5-4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    external: <><path d="M14 4h6v6" /><path d="m10 14 10-10" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** The host cut a request off for using too much CPU (Cloudflare error 1102); the caller can retry with less work. */
class ResourceLimitError extends Error {}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  // Cloudflare answers a resource-limit kill with an HTML or plain-text error page, not JSON.
  const text = await response.text();
  let result: (T & { error?: string }) | undefined;
  try { result = JSON.parse(text) as T & { error?: string }; } catch { result = undefined; }
  if (response.status === 503 || text.includes("error code: 1102")) throw new ResourceLimitError(`${url}: the host stopped this request for using too much CPU (Cloudflare 1102)`);
  if (!response.ok || !result) throw new Error(result?.error ?? `${url} failed (${response.status})`);
  return result;
}

/**
 * One slice of a paginated step. Cloudflare's free plan allows about 10 ms of CPU per request, and a slice of
 * large boards can exceed that; when it does, halve the slice and retry, then grow back towards `max` on success.
 */
async function postSlice<T>(url: string, size: { current: number; max: number }, body: Record<string, unknown> = {}): Promise<T> {
  for (;;) {
    try {
      const result = await post<T>(url, { ...body, limit: size.current });
      if (size.current < size.max) size.current++;
      return result;
    } catch (error) {
      if (!(error instanceof ResourceLimitError) || size.current <= 2) throw error;
      size.current = Math.max(2, Math.floor(size.current / 2));
    }
  }
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sourceStats, setSourceStats] = useState<SourceStats | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState("");
  const [googleRunning, setGoogleRunning] = useState(false);
  const [googleResult, setGoogleResult] = useState<DiscoveryResult | null>(null);
  const stopRequested = useRef(false);
  const scanningRef = useRef(false);

  const [query, setQuery] = useState("");
  const [role, setRole] = useState("All roles");
  const [recency, setRecency] = useState("24 hours");
  const [source, setSource] = useState("All sources");
  const [workplace, setWorkplace] = useState("All locations");
  const [statusFilter, setStatusFilter] = useState("Open");
  const [sort, setSort] = useState("Newest first");
  const [sponsor, setSponsor] = useState("Any sponsorship");
  const [profile, setProfile] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  const loadJobs = async () => {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { jobs: Job[] };
    setJobs(data.jobs);
    const at = Date.now();
    setNow(at);
    setLastRefresh(new Date(at));
  };
  const loadProfile = async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    if (response.ok) setProfile(((await response.json()) as { profile: string }).profile);
  };
  const saveProfileAndRescore = async () => {
    setProfileBusy(true);
    try {
      const saved = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) });
      if (!saved.ok) { setNotice(((await saved.json()) as { error?: string }).error ?? "Could not save the profile."); return; }
      setNotice("Profile saved. Scoring the newest jobs against it…");
      let total = 0;
      for (let pass = 0; pass < 6; pass++) {
        const result = await post<{ scored: number; failed: number; remaining: number }>("/api/internal/score", { limit: 100 });
        total += result.scored;
        setNotice(`Scored ${total} jobs so far… ${result.remaining.toLocaleString()} to go (the rest continue every 5 minutes in the background).`);
        if (result.remaining === 0) break;
      }
      setSort("Best fit first");
      await loadJobs();
    } catch (error) {
      setNotice(`Scoring stopped (${error instanceof Error ? error.message : "unknown error"}). It resumes automatically every 5 minutes.`);
    } finally {
      setProfileBusy(false);
    }
  };
  const loadSourceStats = async () => {
    const response = await fetch("/api/sources", { cache: "no-store" });
    if (response.ok) setSourceStats(await response.json() as SourceStats);
  };

  // Load on open, then refresh every 5 minutes so jobs found by the background scans appear without a reload.
  useEffect(() => {
    // Kicked off from a callback: the loaders only set state after their fetches resolve, never synchronously.
    void Promise.resolve().then(() => Promise.all([loadJobs(), loadSourceStats(), loadProfile()]));
    const timer = setInterval(() => { if (!scanningRef.current) void Promise.all([loadJobs(), loadSourceStats()]); }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * One click does the whole pipeline: stage the catalog, validate pending boards, then scan every active
   * board in slices until none remain. Each request is small so it stays inside hosting time limits.
   */
  const runFullScan = async () => {
    setScanning(true);
    scanningRef.current = true;
    stopRequested.current = false;
    let totalNew = 0, totalRefreshed = 0, boardsScanned = 0;
    try {
      let stats = sourceStats;
      if (!stats?.catalogComplete) {
        let offset = stats?.catalogOffset ?? 0, complete = false;
        while (!complete && !stopRequested.current) {
          setNotice(`Loading company catalog… ${offset.toLocaleString()} / ${(stats?.seedCatalogSize ?? 0).toLocaleString()} boards staged`);
          const result = await post<{ nextOffset: number; complete: boolean }>("/api/sources", { offset, limit: 250 });
          offset = result.nextOffset; complete = result.complete;
        }
      }
      let remainingPending = Infinity, validated = 0, activeFound = 0;
      const validateSize = { current: 30, max: 30 };
      while (remainingPending > 0 && !stopRequested.current) {
        setNotice(`Step 1/2 · Checking boards… ${validated.toLocaleString()} checked, ${activeFound.toLocaleString()} live${Number.isFinite(remainingPending) ? `, ${remainingPending.toLocaleString()} left` : ""}`);
        const result = await postSlice<{ checked: number; active: number; remaining: number }>("/api/internal/validate-sources", validateSize);
        validated += result.checked; activeFound += result.active; remainingPending = result.remaining;
        if (result.checked === 0) break;
      }
      stats = await (await fetch("/api/sources", { cache: "no-store" })).json() as SourceStats;
      setSourceStats(stats);
      // The server picks the cut-off timestamp on the first request; reusing it keeps the loop finite
      // even when the browser clock and the server clock disagree.
      let since: string | undefined;
      let remaining = Infinity;
      // Full-size slices on the Workers Paid plan; postSlice still halves and retries if the host ever refuses one.
      const scanSize = { current: 25, max: 25 };
      while (remaining > 0 && !stopRequested.current) {
        setNotice(`Step 2/2 · Reading job feeds… ${boardsScanned.toLocaleString()} / ${stats.active.toLocaleString()} boards, ${totalNew} new jobs so far`);
        const result = await postSlice<{ scanned: number; inserted: number; updated: number; remaining: number; since: string }>("/api/internal/ingest", scanSize, since ? { since } : {});
        since = result.since;
        boardsScanned += result.scanned; totalNew += result.inserted; totalRefreshed += result.updated; remaining = result.remaining;
        if (result.scanned === 0) break;
        if (boardsScanned % 100 < 25) await loadJobs();
      }
      setNotice(`${stopRequested.current ? "Scan stopped" : "Scan finished"}: ${totalNew} new jobs, ${totalRefreshed} refreshed across ${boardsScanned.toLocaleString()} boards.`);
    } catch (error) {
      const reason = error instanceof ResourceLimitError
        ? "the hosting plan's CPU limit was reached (Cloudflare 1102) — the Workers Free plan allows ~10 ms per request; the Paid plan lifts this"
        : error instanceof Error ? error.message : "unknown error";
      setNotice(`Scan stopped early (${reason}). ${totalNew} new jobs were saved; click Scan again to continue where it left off.`);
    } finally {
      await Promise.all([loadJobs(), loadSourceStats()]);
      scanningRef.current = false;
      setScanning(false);
    }
  };

  /** The Google search button: run every discovery query now, then show what came back. Nothing runs Google on a timer. */
  const runGoogleSearch = async () => {
    setGoogleRunning(true);
    setGoogleResult(null);
    setNotice(`Google search: running ${sourceStats?.creditsPerDiscoveryRun ? "the ATS queries" : "discovery"} for US roles posted in the last 24 hours…`);
    try {
      const result = await post<Omit<DiscoveryResult, "finishedAt">>("/api/internal/discover");
      setGoogleResult({ ...result, finishedAt: new Date().toISOString() });
      setNotice(result.newSources
        ? `Google found ${result.newSources} new compan${result.newSources === 1 ? "y" : "ies"} — click “Scan boards” to check them and pull their jobs.`
        : `Google search finished: ${result.unverifiedJobs} job${result.unverifiedJobs === 1 ? "" : "s"} added to the feed, ${result.bumpedBoards} known board${result.bumpedBoards === 1 ? "" : "s"} queued for a fresh scan.`);
      if (result.unverifiedJobs) setSource("Google finds");
    } catch (error) {
      setNotice(error instanceof ResourceLimitError
        ? "Google search stopped: the hosting plan's CPU limit was reached (Cloudflare 1102). Try again in a minute."
        : error instanceof Error && /SERPER_API_KEY|configured/i.test(error.message) ? "Google search needs the SERPER_API_KEY secret on the Worker." : `Google search failed (${error instanceof Error ? error.message : "unknown error"}).`);
    } finally {
      await Promise.all([loadJobs(), loadSourceStats()]);
      setGoogleRunning(false);
    }
  };

  const sendDigest = async () => {
    setNotice("Preparing digest…");
    const response = await fetch("/api/internal/digest", { method: "POST" });
    const result = await response.json() as { message?: string; sent?: number };
    setNotice(response.ok ? `Email digest sent with ${result.sent ?? 0} jobs.` : result.message ?? "Email digest needs RESEND_API_KEY and JOB_ALERT_EMAIL.");
  };

  const updateStatus = async (id: string, status: Status) => {
    const before = jobs.find(job => job.id === id)?.status;
    setJobs(all => all.map(job => job.id === id ? { ...job, status } : job));
    const response = await fetch("/api/jobs", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }) });
    if (!response.ok && before) setJobs(all => all.map(job => job.id === id ? { ...job, status: before } : job));
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter(job => {
      const haystack = `${job.title} ${job.company} ${job.location}`.toLowerCase();
      const ageHours = (now - new Date(job.postedAt ?? job.discoveredAt).getTime()) / 3600000;
      const statusOk = statusFilter === "All statuses" || (statusFilter === "Open" ? !closedStatuses.includes(job.status) : job.status === statusFilter);
      return (!needle || haystack.includes(needle))
        && statusOk
        && (role === "All roles" || classifyRole(job.title) === role)
        && (source === "All sources" || (source === "Google finds" ? job.source.includes("(Google)") : job.source === source))
        && (workplace === "All locations" || job.workplace === workplace)
        && (sponsor === "Any sponsorship" || job.h1b !== null)
        && ageHours <= recencyHours[recency];
    }).sort((a, b) => {
      const av = new Date(a.postedAt ?? a.discoveredAt).getTime(), bv = new Date(b.postedAt ?? b.discoveredAt).getTime();
      if (sort === "Best fit first") {
        // Unscored and failed (-1) jobs sink to the bottom; ties break by recency.
        const af = a.fitScore ?? -2, bf = b.fitScore ?? -2;
        if (af !== bf) return bf - af;
        return bv - av;
      }
      return sort === "Newest first" ? bv - av : av - bv;
    });
  }, [jobs, query, role, source, workplace, recency, statusFilter, sort, sponsor, now]);

  const openJobs = jobs.filter(job => !closedStatuses.includes(job.status));
  const newCount = openJobs.filter(job => job.status === "New").length;
  const todayCount = openJobs.filter(job => now - new Date(job.postedAt ?? job.discoveredAt).getTime() < 86400000).length;
  const appliedCount = jobs.filter(job => job.status === "Applied").length;
  const interviewCount = jobs.filter(job => job.status === "Interview").length;
  const sources = [...new Set(jobs.map(job => job.source))].sort();
  const lastScanLabel = sourceStats?.lastFullScanAt ? `Full scan ${relativeTime(sourceStats.lastFullScanAt)}` : sourceStats?.lastScheduledRunAt ? `Auto-scan ${relativeTime(sourceStats.lastScheduledRunAt)}` : "No scan yet";

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="radar" /></span><div><strong>Sai Job Radar</strong><span>US data, AI &amp; engineering jobs, one feed</span></div></div>
      <div className="top-actions">
        <span className="live-pill"><i /> {lastScanLabel}</span>
        <button className="secondary-btn google-btn" onClick={() => void runGoogleSearch()} disabled={scanning || googleRunning}><Icon name="search" /> {googleRunning ? "Searching Google…" : "Google search"}</button>
        <button className="secondary-btn" onClick={() => void sendDigest()}><Icon name="mail" /> Email digest</button>
        {scanning
          ? <button className="primary-btn" onClick={() => { stopRequested.current = true; setNotice("Stopping after the current batch…"); }}><Icon name="stop" /> Stop</button>
          : <button className="primary-btn" onClick={() => void runFullScan()} disabled={googleRunning}><Icon name="refresh" /> Scan boards</button>}
      </div>
    </header>

    <section className="workspace">
      <div className="page-heading">
        <div><p className="eyebrow">30-DAY JOB SEARCH</p><h1>Your job command center</h1><p>Only roles posted in the last 24 hours — direct ATS checks every 15 minutes, plus Google search whenever you press the button.</p></div>
        <div className="sync-copy"><span>Last refreshed</span><strong>{lastRefresh ? lastRefresh.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Loading…"}</strong><small>{sourceStats ? `${sourceStats.active.toLocaleString()} live boards` : ""}</small></div>
      </div>

      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification">×</button></div>}

      {googleResult && <section className="google-results" aria-label="Google search results">
        <div className="google-results-head">
          <div><h2><Icon name="search" /> Google search results</h2><p>{googleResult.queries} searches · {googleResult.results} results · finished {relativeTime(googleResult.finishedAt)}{googleResult.creditsUsedTotal ? ` · ${googleResult.creditsUsedTotal.toLocaleString()} Serper credits used in total` : ""}</p></div>
          <button className="secondary-btn" onClick={() => setGoogleResult(null)}>Dismiss</button>
        </div>
        <div className="google-results-grid">
          <article><span>JOBS ADDED TO FEED</span><strong>{googleResult.unverifiedJobs}</strong><small>Postings on boards without an API — shown as “(Google)” in the source column</small></article>
          <article><span>NEW COMPANIES</span><strong>{googleResult.newSources}</strong><small>{googleResult.newSources ? "Queued as pending boards — run “Scan boards” to check them and pull their jobs" : "Every company board in the results is already in your catalog"}</small></article>
          <article><span>KNOWN BOARDS WITH FRESH HITS</span><strong>{googleResult.bumpedBoards}</strong><small>Moved to the front of the next scan</small></article>
          <article className={googleResult.failed ? "warn" : ""}><span>SEARCHES FAILED</span><strong>{googleResult.failed}</strong><small>{googleResult.failed ? googleResult.lastError ?? "Some searches did not return" : "All searches returned"}</small></article>
        </div>
        {googleResult.unverifiedJobs > 0 && <p className="google-results-foot">The feed below is filtered to <b>Google finds</b>. <button className="link-btn" onClick={() => setSource("All sources")}>Show all sources</button></p>}
      </section>}

      <div className="stats-grid">
        <article><span>NEW JOBS</span><strong>{newCount}</strong><small>Waiting for your review</small></article>
        <article><span>POSTED LAST 24H</span><strong>{todayCount}</strong><small>Apply to these first</small></article>
        <article><span>APPLICATIONS</span><strong>{appliedCount}</strong><small>Statuses saved automatically</small></article>
        <article><span>INTERVIEWS</span><strong>{interviewCount}</strong><small>Keep the pipeline moving</small></article>
      </div>

      <section className="panel profile-panel">
        <button className="profile-toggle" onClick={() => setProfileOpen(open => !open)} aria-expanded={profileOpen}>
          <span><Icon name="radar" /> Fit score profile</span>
          <small>{profileOpen ? "Hide" : profile && !profile.startsWith("Not set yet") ? "Edit — jobs are scored 0–100 against this" : "Set up — describe yourself so every job gets a 0–100 fit score"}</small>
        </button>
        {profileOpen && <div className="profile-body">
          <textarea value={profile} onChange={event => setProfile(event.target.value)} rows={9} spellCheck={false} aria-label="Candidate profile" placeholder="Target roles, seniority, skills, years of experience, locations / remote preference, sponsorship needs, things to avoid…" />
          <div className="profile-actions">
            <button className="primary-btn" onClick={() => void saveProfileAndRescore()} disabled={profileBusy || scanning}>{profileBusy ? "Scoring…" : "Save & re-score"}</button>
            <small>Scores come from a small model reading each job&apos;s title, company, location, salary and sponsorship record against this text. Saving clears existing scores; new jobs are scored every 5 minutes.</small>
          </div>
        </div>}
      </section>

      <section className="panel">
        <div className="panel-top">
          <div><h2>Job feed</h2><p>{filtered.length} of {openJobs.length} open jobs match this view</p></div>
          <div className="source-health"><span><i className="healthy" /> {sourceStats ? `${sourceStats.active.toLocaleString()} live boards • ${sourceStats.pending.toLocaleString()} unchecked • ${sourceStats.invalid.toLocaleString()} dead • ${sourceStats.catalogOffset.toLocaleString()}/${sourceStats.seedCatalogSize.toLocaleString()} catalog loaded` : "Loading sources…"}</span></div>
        </div>
        <div className="filters">
          <label className="search-box"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search title, company, or location" aria-label="Search jobs" /></label>
          <select value={role} onChange={event => setRole(event.target.value)} aria-label="Filter by role"><option>All roles</option>{roleFamilies.map(item => <option key={item}>{item}</option>)}</select>
          <select value={recency} onChange={event => setRecency(event.target.value)} aria-label="Filter by age"><option>1 hour</option><option>6 hours</option><option>12 hours</option><option>24 hours</option></select>
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status"><option>Open</option><option>All statuses</option>{statuses.map(item => <option key={item}>{item}</option>)}</select>
          <select value={source} onChange={event => setSource(event.target.value)} aria-label="Filter by source"><option>All sources</option><option>Google finds</option>{sources.map(item => <option key={item}>{item}</option>)}</select>
          <select value={workplace} onChange={event => setWorkplace(event.target.value)} aria-label="Filter by workplace"><option>All locations</option><option>Remote</option><option>Hybrid</option><option>Onsite</option></select>
          <select value={sponsor} onChange={event => setSponsor(event.target.value)} aria-label="Filter by visa sponsorship"><option>Any sponsorship</option><option>H-1B sponsors only</option></select>
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort jobs"><option>Best fit first</option><option>Newest first</option><option>Oldest first</option></select>
        </div>
        <div className="table-wrap">
          <table className="jobs-table">
            <thead><tr><th>ROLE</th><th>LOCATION</th><th>SOURCE</th><th>POSTED / FOUND</th><th>STATUS</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {filtered.map(job => {
                const isNew = now - new Date(job.discoveredAt).getTime() < 86400000;
                return <tr key={job.id}>
                  <td><div className="role-cell"><span className="company-avatar">{job.company.slice(0, 2).toUpperCase()}</span><div><strong>{job.fitScore !== null && job.fitScore >= 0 && <b className={`fit ${job.fitScore >= 75 ? "fit-hi" : job.fitScore >= 50 ? "fit-mid" : "fit-lo"}`} title={job.fitReason ?? ""}>{job.fitScore}</b>}{job.title}</strong><span>{job.company} · {classifyRole(job.title) ?? "Engineering"} · {seniority(job.title)}{job.salary && <> · <b className="salary">{job.salary}</b></>}{job.h1b && <em className="h1b" title={`${job.h1b.name}${job.h1b.approvals ? ` — ${job.h1b.approvals.toLocaleString()} H-1B approvals (FY${job.h1b.fiscalYear}, USCIS Employer Data Hub)` : ""}${job.h1b.lcaLatestFy ? ` — certified H-1B LCAs in FY${job.h1b.lcaLatestFy} (DOL disclosure data)` : ""}${job.h1b.exact ? "" : " — matched by name prefix"}`}>H-1B ✓{job.h1b.approvals ? ` ${job.h1b.approvals.toLocaleString()}` : ""}{job.h1b.lcaLatestFy ? ` · FY${job.h1b.lcaLatestFy}` : ""}</em>}{isNew && <em>NEW</em>}{job.source.includes("(Google)") && <em className="unverified">UNVERIFIED</em>}{job.jdFlags && /no-sponsorship|citizens-only|clearance/.test(job.jdFlags) && <em className="blocker" title={`Description states: ${job.jdFlags.replace(/,/g, ", ")}`}>{job.jdFlags.includes("clearance") ? "CLEARANCE" : job.jdFlags.includes("citizens-only") ? "CITIZENS ONLY" : "NO SPONSORSHIP"}</em>}{job.jdFlags?.includes("sponsorship-offered") && <em className="sponsor-ok" title="Description says visa sponsorship is offered">SPONSORS</em>}</span>{(job.jdSkills || job.jdYears) && <span className="jd-tags">{job.jdYears ? <i className="yrs">{job.jdYears}+ yrs</i> : null}{(job.jdSkills ?? "").split(", ").filter(Boolean).slice(0, 7).map(skill => <i key={skill}>{skill}</i>)}</span>}</div></div></td>
                  <td><strong className="plain-strong">{job.location}</strong><span className={`workplace ${job.workplace.toLowerCase()}`}>{job.workplace}</span></td>
                  <td><span className="source-pill">{job.source}</span></td>
                  <td><strong className="time-main">{job.postedAt ? `Posted ${relativeTime(job.postedAt)}` : "Post date unknown"}</strong><span className="time-sub">Found {relativeTime(job.discoveredAt)} · Seen {relativeTime(job.lastSeenAt)}</span></td>
                  <td><select className={`status-select status-${job.status.toLowerCase()}`} value={job.status} onChange={event => void updateStatus(job.id, event.target.value as Status)} aria-label={`Status for ${job.title}`}>{statuses.map(item => <option key={item}>{item}</option>)}</select></td>
                  <td><a className="apply-link" href={job.applyUrl} target="_blank" rel="noreferrer">Apply <Icon name="external" /></a></td>
                </tr>;
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty-state"><Icon name="search" /><h3>{jobs.length === 0 ? "No jobs yet" : "No jobs match these filters"}</h3><p>{jobs.length === 0 ? "Click “Scan boards” to read every job board, or “Google search” to find new companies and fresh postings." : "Clear a filter or pick a longer time range."}</p></div>}
        </div>
      </section>
      <footer className="footer-note"><span><i className="healthy" /> US roles only • Jobs that leave a board are marked Closed automatically</span><span>{sourceStats?.lastScheduledRunAt ? `Auto-scan last ran ${relativeTime(sourceStats.lastScheduledRunAt)}` : "Auto-scan (every 15 min) has not run yet"}{sourceStats && (sourceStats.discoveryConfigured ? ` • Google discovery every ${sourceStats.discoveryIntervalHours}h (${sourceStats.creditsPerDiscoveryRun} credits/run) ${sourceStats.lastDiscoveryAt ? `last ran ${relativeTime(sourceStats.lastDiscoveryAt)}` : "pending"}, ${sourceStats.discoveredBoards} companies found, ${sourceStats.serperCreditsUsed.toLocaleString()} Serper credits used${SERPER_CREDITS_BOUGHT - sourceStats.serperCreditsUsed < 5000 ? ` ⚠ only ~${Math.max(0, SERPER_CREDITS_BOUGHT - sourceStats.serperCreditsUsed).toLocaleString()} credits left — top up at serper.dev` : ` (~${Math.max(0, SERPER_CREDITS_BOUGHT - sourceStats.serperCreditsUsed).toLocaleString()} left)`}${sourceStats.lastDiscoveryError ? ` • last run: ${sourceStats.lastDiscoveryError}` : ""}` : " • Google discovery off (add SERPER_API_KEY)")}</span></footer>
    </section>
  </main>;
}
