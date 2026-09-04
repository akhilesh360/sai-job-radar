"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { classifyRole, roleFamilies, seniority } from "../lib/roles";

type Status = "New" | "Saved" | "Applied" | "Interview" | "Rejected" | "Archived" | "Closed";
type Job = {
  id: string; title: string; company: string; location: string; workplace: "Remote" | "Hybrid" | "Onsite" | "Unknown";
  source: string; postedAt: string | null; discoveredAt: string; lastSeenAt: string; applyUrl: string; status: Status;
};
type SourceStats = {
  total: number; active: number; pending: number; invalid: number; errored: number; seedCatalogSize: number; catalogOffset: number;
  catalogComplete: boolean; lastFullScanAt: string | null; lastScheduledRunAt: string | null; oldestScanAt: string | null;
  discoveryConfigured: boolean; discoveryIntervalHours: number; creditsPerDiscoveryRun: number; lastDiscoveryAt: string | null; discoveredBoards: number; serperCreditsUsed: number;
};

const statuses: Status[] = ["New", "Saved", "Applied", "Interview", "Rejected", "Archived", "Closed"];
const closedStatuses: Status[] = ["Archived", "Rejected", "Closed"];
const recencyHours: Record<string, number> = { "6 hours": 6, "24 hours": 24, "3 days": 72, "7 days": 168 };

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

async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `${url} failed (${response.status})`);
  return result;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sourceStats, setSourceStats] = useState<SourceStats | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState("");
  const stopRequested = useRef(false);
  const scanningRef = useRef(false);

  const [query, setQuery] = useState("");
  const [role, setRole] = useState("All roles");
  const [recency, setRecency] = useState("7 days");
  const [source, setSource] = useState("All sources");
  const [workplace, setWorkplace] = useState("All locations");
  const [statusFilter, setStatusFilter] = useState("Open");
  const [sort, setSort] = useState("Newest first");

  const loadJobs = async () => {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { jobs: Job[] };
    setJobs(data.jobs);
    const at = Date.now();
    setNow(at);
    setLastRefresh(new Date(at));
  };
  const loadSourceStats = async () => {
    const response = await fetch("/api/sources", { cache: "no-store" });
    if (response.ok) setSourceStats(await response.json() as SourceStats);
  };

  // Load on open, then refresh every 5 minutes so jobs found by the background scans appear without a reload.
  useEffect(() => {
    void Promise.all([loadJobs(), loadSourceStats()]);
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
      while (remainingPending > 0 && !stopRequested.current) {
        setNotice(`Checking catalog boards… ${validated.toLocaleString()} checked, ${activeFound.toLocaleString()} live${Number.isFinite(remainingPending) ? `, ${remainingPending.toLocaleString()} left` : ""}`);
        const result = await post<{ checked: number; active: number; remaining: number }>("/api/internal/validate-sources", { limit: 30 });
        validated += result.checked; activeFound += result.active; remainingPending = result.remaining;
        if (result.checked === 0) break;
      }
      stats = await (await fetch("/api/sources", { cache: "no-store" })).json() as SourceStats;
      setSourceStats(stats);
      // The server picks the cut-off timestamp on the first request; reusing it keeps the loop finite
      // even when the browser clock and the server clock disagree.
      let since: string | undefined;
      let remaining = Infinity;
      while (remaining > 0 && !stopRequested.current) {
        setNotice(`Scanning boards… ${boardsScanned.toLocaleString()} / ${stats.active.toLocaleString()} scanned, ${totalNew} new jobs so far`);
        const result = await post<{ scanned: number; inserted: number; updated: number; remaining: number; since: string }>("/api/internal/ingest", { limit: 25, since });
        since = result.since;
        boardsScanned += result.scanned; totalNew += result.inserted; totalRefreshed += result.updated; remaining = result.remaining;
        if (result.scanned === 0) break;
        if (boardsScanned % 100 < 25) await loadJobs();
      }
      setNotice(`${stopRequested.current ? "Scan stopped" : "Scan finished"}: ${totalNew} new jobs, ${totalRefreshed} refreshed across ${boardsScanned.toLocaleString()} boards.`);
    } catch (error) {
      setNotice(`Scan stopped early (${error instanceof Error ? error.message : "unknown error"}). ${totalNew} new jobs were saved; click Scan again to continue where it left off.`);
    } finally {
      await Promise.all([loadJobs(), loadSourceStats()]);
      scanningRef.current = false;
      setScanning(false);
    }
  };

  const runDiscovery = async () => {
    setNotice("Asking Google for company boards not in the catalog yet…");
    const response = await fetch("/api/internal/discover", { method: "POST" });
    const result = await response.json() as { configured?: boolean; newSources?: number; bumpedBoards?: number; unverifiedJobs?: number; queries?: number; error?: string };
    setNotice(!response.ok || !result.configured ? (result.error ?? "Google discovery needs a SERPER_API_KEY setting on the site.") : `Google discovery finished: ${result.newSources ?? 0} new companies, ${result.bumpedBoards ?? 0} known boards with fresh postings queued first, ${result.unverifiedJobs ?? 0} unverified jobs added from ${result.queries ?? 0} searches. New companies are scanned on the next auto-scan (or click Scan all boards).`);
    await loadSourceStats();
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
        && (source === "All sources" || job.source === source)
        && (workplace === "All locations" || job.workplace === workplace)
        && ageHours <= recencyHours[recency];
    }).sort((a, b) => {
      const av = new Date(a.postedAt ?? a.discoveredAt).getTime(), bv = new Date(b.postedAt ?? b.discoveredAt).getTime();
      return sort === "Newest first" ? bv - av : av - bv;
    });
  }, [jobs, query, role, source, workplace, recency, statusFilter, sort, now]);

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
        <button className="secondary-btn" onClick={() => void runDiscovery()} disabled={scanning}><Icon name="search" /> Find new companies</button>
        <button className="secondary-btn" onClick={() => void sendDigest()}><Icon name="mail" /> Email digest</button>
        {scanning
          ? <button className="primary-btn" onClick={() => { stopRequested.current = true; setNotice("Stopping after the current batch…"); }}><Icon name="stop" /> Stop</button>
          : <button className="primary-btn" onClick={() => void runFullScan()}><Icon name="refresh" /> Scan all boards</button>}
      </div>
    </header>

    <section className="workspace">
      <div className="page-heading">
        <div><p className="eyebrow">30-DAY JOB SEARCH</p><h1>Your job command center</h1><p>Openings from the last 7 days, pulled straight from company ATS boards the moment they are posted.</p></div>
        <div className="sync-copy"><span>Last refreshed</span><strong>{lastRefresh ? lastRefresh.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Loading…"}</strong><small>{sourceStats ? `${sourceStats.active.toLocaleString()} live boards` : ""}</small></div>
      </div>

      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification">×</button></div>}

      <div className="stats-grid">
        <article><span>NEW JOBS</span><strong>{newCount}</strong><small>Waiting for your review</small></article>
        <article><span>POSTED TODAY</span><strong>{todayCount}</strong><small>Apply to these first</small></article>
        <article><span>APPLICATIONS</span><strong>{appliedCount}</strong><small>Statuses saved automatically</small></article>
        <article><span>INTERVIEWS</span><strong>{interviewCount}</strong><small>Keep the pipeline moving</small></article>
      </div>

      <section className="panel">
        <div className="panel-top">
          <div><h2>Job feed</h2><p>{filtered.length} of {openJobs.length} open jobs match this view</p></div>
          <div className="source-health"><span><i className="healthy" /> {sourceStats ? `${sourceStats.active.toLocaleString()} live boards • ${sourceStats.pending.toLocaleString()} unchecked • ${sourceStats.invalid.toLocaleString()} dead • ${sourceStats.catalogOffset.toLocaleString()}/${sourceStats.seedCatalogSize.toLocaleString()} catalog loaded` : "Loading sources…"}</span></div>
        </div>
        <div className="filters">
          <label className="search-box"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search title, company, or location" aria-label="Search jobs" /></label>
          <select value={role} onChange={event => setRole(event.target.value)} aria-label="Filter by role"><option>All roles</option>{roleFamilies.map(item => <option key={item}>{item}</option>)}</select>
          <select value={recency} onChange={event => setRecency(event.target.value)} aria-label="Filter by age"><option>6 hours</option><option>24 hours</option><option>3 days</option><option>7 days</option></select>
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status"><option>Open</option><option>All statuses</option>{statuses.map(item => <option key={item}>{item}</option>)}</select>
          <select value={source} onChange={event => setSource(event.target.value)} aria-label="Filter by source"><option>All sources</option>{sources.map(item => <option key={item}>{item}</option>)}</select>
          <select value={workplace} onChange={event => setWorkplace(event.target.value)} aria-label="Filter by workplace"><option>All locations</option><option>Remote</option><option>Hybrid</option><option>Onsite</option></select>
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort jobs"><option>Newest first</option><option>Oldest first</option></select>
        </div>
        <div className="table-wrap">
          <table className="jobs-table">
            <thead><tr><th>ROLE</th><th>LOCATION</th><th>SOURCE</th><th>POSTED / FOUND</th><th>STATUS</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {filtered.map(job => {
                const isNew = now - new Date(job.discoveredAt).getTime() < 86400000;
                return <tr key={job.id}>
                  <td><div className="role-cell"><span className="company-avatar">{job.company.slice(0, 2).toUpperCase()}</span><div><strong>{job.title}</strong><span>{job.company} · {classifyRole(job.title) ?? "Engineering"} · {seniority(job.title)}{isNew && <em>NEW</em>}{job.source.includes("(Google)") && <em className="unverified">UNVERIFIED</em>}</span></div></div></td>
                  <td><strong className="plain-strong">{job.location}</strong><span className={`workplace ${job.workplace.toLowerCase()}`}>{job.workplace}</span></td>
                  <td><span className="source-pill">{job.source}</span></td>
                  <td><strong className="time-main">{job.postedAt ? `Posted ${relativeTime(job.postedAt)}` : "Post date unknown"}</strong><span className="time-sub">Found {relativeTime(job.discoveredAt)} · Seen {relativeTime(job.lastSeenAt)}</span></td>
                  <td><select className={`status-select status-${job.status.toLowerCase()}`} value={job.status} onChange={event => void updateStatus(job.id, event.target.value as Status)} aria-label={`Status for ${job.title}`}>{statuses.map(item => <option key={item}>{item}</option>)}</select></td>
                  <td><a className="apply-link" href={job.applyUrl} target="_blank" rel="noreferrer">Apply <Icon name="external" /></a></td>
                </tr>;
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty-state"><Icon name="search" /><h3>{jobs.length === 0 ? "No jobs yet" : "No jobs match these filters"}</h3><p>{jobs.length === 0 ? "Click “Scan all boards” to pull live openings from every company board." : "Clear a filter or pick a longer time range."}</p></div>}
        </div>
      </section>
      <footer className="footer-note"><span><i className="healthy" /> US roles only • Jobs that leave a board are marked Closed automatically</span><span>{sourceStats?.lastScheduledRunAt ? `Auto-scan last ran ${relativeTime(sourceStats.lastScheduledRunAt)}` : "Auto-scan (every 15 min) has not run yet"}{sourceStats && (sourceStats.discoveryConfigured ? ` • Google discovery every ${sourceStats.discoveryIntervalHours}h (${sourceStats.creditsPerDiscoveryRun} credits/run) ${sourceStats.lastDiscoveryAt ? `last ran ${relativeTime(sourceStats.lastDiscoveryAt)}` : "pending"}, ${sourceStats.discoveredBoards} companies found, ${sourceStats.serperCreditsUsed.toLocaleString()} Serper credits used` : " • Google discovery off (add SERPER_API_KEY)")}</span></footer>
    </section>
  </main>;
}
