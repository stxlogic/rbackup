import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";
import { loadProfiles, type Profile } from "./profiles";
import SnapshotBrowser, { type Entry, type Snapshot } from "./SnapshotBrowser";
import SchedulePanel from "./SchedulePanel";
import OperationOutput from "./OperationOutput";
import RcloneSetup from "./RcloneSetup";
import S3Setup from "./S3Setup";
import { schedulerAction } from "./scheduler";

type MountedSnapshot = { snapshot: string; path: string; repository: string };
type Result = { stdout: string; stderr: string; code: number; interruptedMaintenance?: string };
/** Create a new repository profile with a random UUID and empty connection and backup settings. */
const blank = (): Profile => ({ id: crypto.randomUUID(), name: "My repository", repository: "", passwordFile: "", sources: "", excludes: "", tags: "" });
/** Load saved profiles. Return a blank profile if none exist or storage, JSON parsing, or validation fails. */
function load(): Profile[] {
    try {
        const profiles = loadProfiles(localStorage);
        return profiles.length ? profiles : [blank()];
    } catch {
        return [blank()];
    }
}
/** Split multiline source paths, excludes, or tags into trimmed, nonempty strings. */
const lines = (s: string) => s.split("\n").map(s => s.trim()).filter(Boolean);
/** Format a byte count using B, KB, MB, or GB with powers of 1024. */
const size = (n = 0) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

type Theme = "system" | "light" | "dark";

/** Render the desktop workspace and own theme, profiles, connection, operation, snapshot, restore, and retention state. Browser mode previews the interface without executing restic. */
function App() {
    const [theme, setTheme] = useState<Theme>(() => {
        try {
            const saved = localStorage.getItem("restic-theme");
            return saved === "light" || saved === "dark" ? saved : "system";
        } catch { return "system"; }
    });
    useEffect(() => {
        const system = window.matchMedia("(prefers-color-scheme: dark)");
        const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (system.matches ? "dark" : "light") : theme; };
        apply();
        try { localStorage.setItem("restic-theme", theme); } catch { /* Theme still works without storage. */ }
        system.addEventListener("change", apply);
        return () => system.removeEventListener("change", apply);
    }, [theme]);
    const [profiles, setProfiles] = useState<Profile[]>(load);
    const [active, setActive] = useState(() => {
        try {
            const saved = localStorage.getItem("restic-active-profile");
            return profiles.find(p => p.id === saved)?.id ?? profiles[0].id;
        } catch { return profiles[0].id; }
    });
    useEffect(() => {
        try { localStorage.setItem("restic-active-profile", active); } catch { /* Selection still works without storage. */ }
    }, [active]);
    const profile = profiles.find(p => p.id === active)!;
    const [password, setPassword] = useState("");
    const [tab, setTab] = useState(profile.repository ? "Overview" : "Repository");
    const mobileMenu = useRef<HTMLDialogElement>(null);
    const pageHeading = useRef<HTMLHeadingElement>(null);
    const mainContent = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => {
        const phone = window.matchMedia("(max-width: 720px)");
        const closeOnDesktop = () => { if (!phone.matches) mobileMenu.current?.close(); };
        phone.addEventListener("change", closeOnDesktop);
        return () => phone.removeEventListener("change", closeOnDesktop);
    }, []);
    function navigate(name: string) {
        setTab(name); setQuery(""); mobileMenu.current?.close();
        requestAnimationFrame(() => {
            pageHeading.current?.focus({ preventScroll: true });
            mainContent.current?.scrollTo({ top: 0 });
        });
    }
    const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
    const [connected, setConnected] = useState(false);
    const [repositoryMissing, setRepositoryMissing] = useState(false);
    const [selected, setSelected] = useState("");
    const [browserOpen, setBrowserOpen] = useState(false);
    const [mounted, setMounted] = useState<MountedSnapshot | null>(null);
    const [mountBusy, setMountBusy] = useState(false);
    const [mountError, setMountError] = useState("");
    const [listing, setListing] = useState(false);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState("");
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState("");
    const [notice, setNotice] = useState("");
    const [noticeTone, setNoticeTone] = useState<"success" | "warning" | "error">("error");
    const [output, setOutput] = useState("");
    const [activity, setActivity] = useState<{ operation: string; time: string; result: string; tone: "success" | "warning" | "error" }[]>([]);
    const [dryRun, setDryRun] = useState(true);
    const [readData, setReadData] = useState(false);
    const [policy, setPolicy] = useState({ keepLast: 3, keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    const [preview, setPreview] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [stats, setStats] = useState<{ total_size?: number; total_file_count?: number } | null>(null);
    const desktop = isTauri();
    const synchronizedProfiles = useRef(new Map<string, string>());
    const synchronization = useRef<Promise<void>>(Promise.resolve());
    const [scheduleSyncError, setScheduleSyncError] = useState("");
    /** Serialize profile snapshot updates so background backups use the latest saved settings. */
    function syncProfiles(current: Profile[]) {
        synchronization.current = synchronization.current.then(async () => {
            let failure = "";
            for (const item of current) {
                const serialized = JSON.stringify(item);
                if (synchronizedProfiles.current.get(item.id) === serialized) continue;
                try {
                    await schedulerAction("sync", item.id, item);
                    synchronizedProfiles.current.set(item.id, serialized);
                } catch (error) { failure = String(error); }
            }
            setScheduleSyncError(failure);
        });
        return synchronization.current;
    }
    useEffect(() => {
        if (!desktop) return;
        const timer = window.setTimeout(() => void syncProfiles(profiles), 500);
        return () => window.clearTimeout(timer);
    }, [profiles, desktop]);
    async function flushScheduleProfiles() {
        if (desktop) await syncProfiles(profiles);
    }
    function addProfile() {
        const next = blank();
        next.name = "New profile";
        for (let number = 2; profiles.some(item => item.name === next.name); number++) {
            next.name = `New profile ${number}`;
        }
        save([...profiles, next]);
        reset();
        setActive(next.id);
        navigate("Repository");
    }
    /** Remove the schedule and stop its service before deleting the local profile. */
    async function removeProfile() {
        if (!window.confirm("Remove this saved profile and its schedule? Repository data and password files will remain.")) return;
        setBusy("profile removal"); setNotice("");
        try {
            if (desktop) { await synchronization.current; await schedulerAction("remove", profile.id); }
            const next = profiles.filter(p => p.id !== active);
            save(next); reset(); setActive(next[0].id);
        } catch (error) { setNoticeTone("error"); setNotice(String(error)); }
        finally { setBusy(""); }
    }
    /** Update profile state and persist the supplied profiles in local storage. Storage errors propagate to the caller. */
    function save(next: Profile[]) { setProfiles(next); localStorage.setItem("restic-profiles", JSON.stringify(next)); }
    /** Clear the session password, loaded repository data, connection status, retention preview, output, and notice when switching profiles. Activity history remains session-wide. */
    function reset() { setRepositoryMissing(false); setPassword(""); setSnapshots([]); setSelected(""); setBrowserOpen(false); setConnected(false); setPreview(""); setConfirmation(""); setStats(null); setOutput(""); setNotice(""); }
    /** Persist one field of the active profile. Repository or password-file changes invalidate loaded connection data and retention previews. */
    function update<K extends keyof Profile>(key: K, value: Profile[K]) { save(profiles.map(p => p.id === active ? { ...p, [key]: value } : p)); if (key === "repository" || key === "passwordFile") { setRepositoryMissing(false); setConnected(false); setSnapshots([]); setSelected(""); setBrowserOpen(false); setStats(null); setPreview(""); } }
    function invokeRestic(operation: string, extra: Record<string, unknown> = {}) {
        return invoke<Result>("run_restic", { request: { repository: profile.repository, password, passwordFile: profile.passwordFile, operation, maintenance: profile.maintenance, paths: lines(profile.sources), excludes: lines(profile.excludes), tags: lines(profile.tags), snapshot: selected, ...policy, confirmation, ...extra } });
    }
    /** Run and record one operation, reloading snapshots after a backup or prune. */
    async function run(operation: string, extra: Record<string, unknown> = {}, throwErrors = false) {
        if (busy) return null;
        const dryRun = extra.dryRun === true;
        const backupPreview = operation === "backup" && dryRun;
        const retentionPreview = operation === "forget" && dryRun;
        const label = backupPreview ? "backup preview" : retentionPreview ? "retention preview" : operation;
        let reloadSnapshots = false;
        setCancelling(false); setCancelError("");
        setBusy(label); setNotice(""); setNoticeTone("error"); setOutput("");
        try {
            if (!desktop) throw new Error("Open the desktop app with npm run tauri dev to run restic. Browser mode only previews the interface.");
            const result = await invokeRestic(operation, extra);
            setOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
            const incomplete = operation === "backup" && result.code === 3 && !result.interruptedMaintenance;
            reloadSnapshots = (operation === "backup" && !dryRun && (result.code === 0 || incomplete || !!result.interruptedMaintenance))
                || (operation === "prune" && result.code === 0);
            const tone: typeof noticeTone = result.code === 0 ? "success" : incomplete || result.code === 130 || (operation === "snapshots" && result.code === 10) ? "warning" : "error";
            const outcome = result.interruptedMaintenance
                ? `Backup completed; maintenance ${result.code === 130 ? "cancelled" : `failed (exit ${result.code})`}`
                : incomplete ? "Some files skipped · Exit 3" : result.code === 130 ? "Cancelled" : `Exit ${result.code}`;
            setActivity(a => [{ operation: label, time: new Date().toLocaleString(), result: outcome, tone }, ...a].slice(0, 20));
            if (result.interruptedMaintenance) {
                setNoticeTone(tone);
                setNotice(`Backup completed. Automatic ${result.interruptedMaintenance} ${result.code === 130 ? "was cancelled" : `failed with exit ${result.code}`}. Open Logs.`);
                return null;
            }
            if (result.code === 130) {
                setNoticeTone("warning");
                setNotice(operation === "snapshots"
                    ? connected ? "Repository refresh cancelled." : "Repository connection cancelled."
                    : dryRun ? `${label} cancelled.`
                        : `${label} cancelled. Changes already made are not undone. Refresh repository data before continuing.`);
                if (dryRun) return null;
                setConnected(false); setSnapshots([]); setSelected(""); setBrowserOpen(false); setStats(null); setPreview("");
                return null;
            }
            // Restic uses exit 10 when the repository does not exist.
            if (operation === "snapshots" && result.code === 10) {
                setRepositoryMissing(true);
                setSnapshots([]); setSelected(""); setBrowserOpen(false); setStats(null); setPreview("");
                setNoticeTone("warning");
                setNotice(`No repository found at ${profile.repository}. You can initialize one in Repository settings.`);
                setTab("Repository");
                return null;
            }
            if (incomplete) {
                setNoticeTone(tone);
                setNotice(backupPreview
                    ? "Backup preview finished with unreadable files skipped. No snapshot was created. Open Logs for the errors."
                    : "Backup continued with unreadable files skipped. Open Logs for the errors.");
                return null;
            }
            if (result.code !== 0) {
                setNoticeTone(tone);
                throw new Error(`restic ${label} exited with code ${result.code}. Open Logs for details.`);
            }
            setNoticeTone("success");
            if (operation !== "snapshots") setNotice(backupPreview ? "Backup preview completed. No snapshot was created."
                : retentionPreview ? "Retention preview ready. Open Logs to review it."
                    : operation === "backup" ? (profile.maintenance ? "Backup and automatic maintenance completed." : "Backup completed.")
                        : `${operation} completed successfully.`);
            return result;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const context = operation === "snapshots" ? (connected ? "Could not refresh repository. " : "Could not connect to repository. ") : "";
            setNotice(context + reason);
            if (throwErrors) throw error;
            return null;
        }
        finally {
            if (reloadSnapshots) {
                setBusy("snapshot reload"); setCancelling(false);
                setStats(null); setPreview("");
                try {
                    const result = await invokeRestic("snapshots");
                    if (result.code !== 0) throw new Error(result.stderr || `Snapshot reload exited with code ${result.code}.`);
                    loadSnapshotList(result.stdout);
                } catch (error) {
                    setConnected(false);
                    setNoticeTone(tone => tone === "success" ? "warning" : tone);
                    setNotice(message => `${message} Could not reload snapshots. Use Connect / refresh to retry.`);
                    setOutput(previous => [previous, `Snapshot reload: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("\n"));
                }
            }
            setBusy(""); setCancelling(false);
        }
    }
    /** Request cancellation of the current app-owned restic operation. */
    async function cancelOperation() {
        setCancelling(true); setCancelError("");
        try { await invoke("cancel_restic"); }
        catch (error) {
            setCancelling(false);
            setCancelError(error instanceof Error ? error.message : String(error));
        }
    }
    /** Create a managed password file and persist its returned location in the profile. */
    async function createPasswordFile() {
        if (busy) return;
        setBusy("password file creation"); setNotice(""); setNoticeTone("error");
        try {
            if (!desktop) throw new Error("Open the desktop app to create a password file.");
            const path = await invoke<string>("create_password_file", { profileId: profile.id, password });
            update("passwordFile", path);
            setNoticeTone("success");
            setNotice("Password file created. This profile will use it for repository operations.");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error));
        } finally { setBusy(""); setCancelling(false); }
    }
    function loadSnapshotList(stdout: string) {
        const data = JSON.parse(stdout) as Snapshot[] | null;
        setSnapshots((data ?? []).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)));
        setRepositoryMissing(false); setConnected(true);
        setSelected(""); setBrowserOpen(false); setPreview("");
    }
    /** Mark the repository connected only after reading its snapshot list. */
    async function refresh() {
        if (busy) return;
        setRepositoryMissing(false);
        const result = await run("snapshots");
        if (result) { try { loadSnapshotList(result.stdout); setNotice(connected ? "Repository refreshed." : "Repository connected."); } catch { setNoticeTone("error"); setNotice("Could not read the repository’s snapshot list."); setConnected(false); } }
        else setConnected(false);
    }
    async function deleteSnapshot(snapshot: Snapshot) {
        const label = snapshot.short_id || snapshot.id.slice(0, 8);
        if (!window.confirm(`Permanently delete snapshot ${label} from ${snapshot.hostname}, created ${new Date(snapshot.time).toLocaleString()}? This recovery point cannot be restored after deletion.`)) return;
        const result = await run("delete snapshot", { operation: "forget_snapshot", snapshot: snapshot.id, confirmation: "FORGET" });
        if (!result) return;

        setSnapshots(current => current.filter(item => item.id !== snapshot.id));
        if (selected === snapshot.id) {
            setSelected("");
            setBrowserOpen(false);
        }
        setStats(null);
        setPreview("");
        setConfirmation("");
        setNotice(`Snapshot ${label} deleted.`);
    }
    // Reconnect after the selected profile and its session credentials have been reset.
    useEffect(() => {
        if (!desktop || !profile.repository.trim()) return;
        const timer = window.setTimeout(() => {
            if (profile.passwordFile.trim()) void refresh();
            else {
                setTab("Repository");
                setNoticeTone("warning");
                setNotice("Enter your session password and connect, or save a password file to reconnect automatically next time.");
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, [active, desktop]);
    async function loadDirectory(snapshot: string, directory: string): Promise<Entry[]> {
        if (!desktop) throw new Error("Open the desktop app to browse snapshots.");
        setListing(true);
        try {
            if (mounted?.snapshot === snapshot && mounted.repository === profile.repository) {
                const entries = await invoke<Entry[]>("snapshot_mount_entries", { snapshot, directory });
                return entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.path.localeCompare(b.path));
            }
            const result = await invoke<Result>("run_restic", {
                request: {
                    repository: profile.repository, password, passwordFile: profile.passwordFile,
                    operation: "ls", snapshot, directory,
                }
            });
            if (result.code !== 0) throw new Error(result.stderr || `Folder listing failed (${result.code}).`);
            return result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
                .filter(node => node.struct_type === "node" && node.path !== directory)
                .sort((a: Entry, b: Entry) => Number(b.type === "dir") - Number(a.type === "dir") || a.path.localeCompare(b.path));
        } finally { setListing(false); }
    }
    async function mountAction(action: "start" | "stop", snapshot = selected) {
        if (mountBusy) return;
        setMountBusy(true); setMountError("");
        try {
            const info = await invoke<MountedSnapshot | null>("snapshot_mount", {
                action, request: action === "start" ? {
                    repository: profile.repository, password,
                    passwordFile: profile.passwordFile, operation: "ls", snapshot
                } : null,
            });
            setMounted(info); setNoticeTone("success");
            setNotice(action === "stop" ? "Snapshot unmounted." : "Snapshot mounted read-only. Copy its path to open it manually.");
        } catch (error) {
            setNoticeTone("error"); setNotice(String(error));
            setMountError(String(error));
            // Refresh state in case a mount process exited during the operation.
            try { setMounted(await invoke("snapshot_mount", { action: "status", request: null })); } catch { /* Original error is already shown. */ }
        } finally { setMountBusy(false); }
    }
    useEffect(() => {
        if (!desktop) return;
        void invoke<MountedSnapshot | null>("snapshot_mount", { action: "status", request: null })
            .then(setMounted).catch(() => { /* Mounting is unavailable on some platforms. */ });
    }, [desktop]);
    function browseMounted() {
        if (!mounted) return;
        const owner = profiles.find(item => item.repository === mounted.repository);
        if (!owner) { setNoticeTone("error"); setNotice("Select or add the mounted repository profile before restoring its files."); return; }
        if (owner.id !== active) { reset(); setActive(owner.id); }
        setSelected(mounted.snapshot); setBrowserOpen(true);
    }
    const chosen = snapshots.find(s => s.id === selected) ||
        (mounted?.snapshot === selected && mounted.repository === profile.repository
            ? { id: mounted.snapshot, short_id: mounted.snapshot.slice(0, 8), hostname: "Read-only mount", time: "", paths: [] } : undefined);
    const filtered = snapshots.filter(s => `${s.id} ${s.hostname} ${s.paths.join(" ")} ${s.tags?.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
    const policyKey = JSON.stringify([active, profile.repository, policy]);
    const progressText = busy === "snapshots"
        ? cancelling ? (connected ? "Cancelling repository refresh…" : "Cancelling repository connection…")
            : connected ? "Refreshing repository…" : "Connecting to repository…"
        : cancelling ? `Cancelling ${busy}… Waiting for restic to stop.`
            : busy === "snapshot reload" ? "Reloading snapshots…"
                : `Running ${busy}… Keep the app open until it finishes.`;
    const sidebarContents = <>
        <div className="brand"><img className="brand-mark" src="/rbackup.svg" alt="" width="40" height="40" /><div>rbackup<span>Backup Manager for Restic</span></div></div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{["Overview", "Repository", "Backup", "Snapshots", "Maintenance", "Logs"].map((name, i) => <button key={name} className={tab === name ? "nav-item active" : "nav-item"} onClick={() => navigate(name)} aria-current={tab === name ? "page" : undefined}><span aria-hidden="true">{["◫", "▣", "↑", "◷", "⚙", "≡"][i]}</span>{name}</button>)}</nav>
        <div className="sidebar-bottom"><span className="dot" /> Local desktop workspace<p>Encrypted backups.<br />Recovery you control.</p><button className="text-button" disabled={!!busy || listing || mountBusy} onClick={() => void run("version")}>Check restic version ↗</button></div>
    </>;
    return <div className="app-shell">
        <aside className="sidebar desktop-sidebar">{sidebarContents}</aside>
        <dialog ref={mobileMenu} id="mobile-navigation" className="mobile-menu" aria-label="Main navigation"
            onClose={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget) mobileMenu.current?.close(); }}>
            <aside className="sidebar mobile-sidebar">
                <div className="mobile-menu-heading"><span>Navigation</span><button aria-label="Close navigation" onClick={() => mobileMenu.current?.close()}>✕</button></div>
                {sidebarContents}
            </aside>
        </dialog>
        <main>
            <header><div className="header-navigation"><button className="menu-toggle" aria-label="Open navigation" aria-haspopup="dialog" aria-controls="mobile-navigation" aria-expanded={menuOpen}
                onClick={() => { mobileMenu.current?.showModal(); setMenuOpen(true); }}><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><div className="breadcrumb">Workspace <span>/</span> {tab}</div></div><div className="header-controls"><label className="theme-control">Theme<select value={theme} onChange={e => setTheme(e.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><div role="status" className={`connection status-${connected ? "success" : "warning"}`}><span className="dot" aria-hidden="true" />{connected ? "Repository connected" : "Not connected"}</div></div></header>
            <div className="main-content" ref={mainContent} role="region" aria-label="Workspace content" tabIndex={0}>
            <div className="page-heading"><div>
                {/* <div className="eyebrow">YOUR DATA, PROTECTED</div> */}
                <h1 ref={pageHeading} tabIndex={-1}>{tab === "Overview" ? "Backup overview" : tab}</h1>
                <p>{({ Overview: "A clear view of your backups, from source to recovery.", Repository: "Connect to an existing repository or create an encrypted one.", Backup: "Choose what matters. Keep a recoverable copy.", Snapshots: "Explore your history and bring your files back.", Maintenance: "Check integrity and manage your retention policy.", Logs: "Review command output and recent runs." } as Record<string, string>)[tab]}</p>
            </div><button disabled={!!busy || listing || mountBusy} className="primary" onClick={() => void refresh()}>↻ Connect / refresh</button></div>
            {!desktop && <div className="banner">Interface preview · Run the Tauri desktop app to connect to restic.</div>}
            <div className="profile-bar">
                <label>Backup profile<select disabled={!!busy || listing || mountBusy} value={active} onChange={e => { reset(); setActive(e.target.value); }}>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <button className="primary" disabled={!!busy || listing || mountBusy} onClick={addProfile}>+ New profile</button>
                <code>{profile.repository || "No location configured"}</code>
            </div>
            <div role="status" aria-live="polite" className={`status${busy || notice ? " visible" : ""} status-${busy ? "progress" : noticeTone}`}>{busy ? <><span className="spinner" /> {progressText}</> : notice}</div>
            {busy && busy !== "password file creation" && busy !== "profile removal" && <div className="actions cancel-actions"><button className="danger" disabled={cancelling} onClick={() => void cancelOperation()}>{cancelling ? "Cancelling…" : "Cancel operation"}</button>{cancelError && <span role="alert" className="result-error">{cancelError}</span>}</div>}
            {tab !== "Logs" && output && <button className="open-logs" onClick={() => navigate("Logs")}>Open logs</button>}
            {scheduleSyncError && <p role="alert" className="result-error">Schedule synchronization: {scheduleSyncError}</p>}
            {mounted && <div className="mount-status"><span>Read-only mount · <code>{mounted.snapshot.slice(0, 8)}</code></span><code>{mounted.path}</code><button disabled={mountBusy || !!busy || listing} onClick={browseMounted}>Browse mounted snapshot</button><button disabled={mountBusy} onClick={() => void mountAction("stop")}>{mountBusy ? "Working…" : "Unmount"}</button></div>}
            <fieldset disabled={!!busy || listing || mountBusy} className="workspace">
                {tab === "Overview" && <>
                    <div className="metrics"><article><span>AVAILABLE SNAPSHOTS</span><strong>{connected ? snapshots.length : "—"}</strong><small>{connected ? "In this repository" : "Connect to load snapshots"}</small></article><article><span>LATEST BACKUP</span><strong className="date-value">{snapshots.length ? new Date([...snapshots].sort((a, b) => b.time.localeCompare(a.time))[0].time).toLocaleDateString() : "—"}</strong><small>{snapshots.length ? "Most recent snapshot" : "No snapshot loaded"}</small></article><article><span>RESTORE SIZE</span><strong>{stats ? size(stats.total_size) : "—"}</strong><small>{stats ? `${stats.total_file_count ?? 0} files (all snapshots)` : "Load statistics below"}</small></article></div>
                    <div className="columns"><section className="card"><div className="card-heading"><h2>Your backup workflow</h2><span className="badge">RESTIC POWERED</span></div>{[["01", "Connect a repository", "Set your storage location and unlock credentials.", "Repository"], ["02", "Create a snapshot", "Back up files with tags and exclusion patterns.", "Backup"], ["03", "Test your recovery", "Browse snapshots and restore into a new folder.", "Snapshots"]].map(([n, title, description, destination]) => <button className="workflow" key={n} onClick={() => navigate(destination)}><span className="step">{n}</span><div><strong>{title}</strong><p>{description}</p></div><span>→</span></button>)}</section><section className="card"><h2>Repository health</h2><p>Check the repository structure regularly, and run a full data check when you need deeper verification.</p><button onClick={() => void run("check")}>Run integrity check</button><button onClick={async () => { const r = await run("stats"); if (r) { try { setStats(JSON.parse(r.stdout)); } catch { setNoticeTone("error"); setNotice("Could not parse repository statistics."); } } }}>Load statistics</button><div className="tip">Keep your repository password somewhere safe. A backup is useful only if you can restore it.</div></section></div>
                </>}
                {tab === "Repository" && <section className="card form-card"><h2>Repository settings</h2><p>Profile settings save automatically on this device. Typed passwords stay in memory unless you explicitly create a password file.</p>{profile.repository.startsWith("sftp:") && <p className="banner">SFTP uses SSH authentication separately from the repository encryption password. Configure an SSH key or agent and verify the server’s host key outside the app. Connections run without password or host-trust prompts.</p>}<label>Profile name<input value={profile.name} onChange={e => update("name", e.target.value)} /></label><label>Repository location<input placeholder="/mnt/backups/restic or sftp:user@host:/backup" value={profile.repository} onChange={e => update("repository", e.target.value)} spellCheck={false} /></label><RcloneSetup key={`rclone:${profile.id}`} useLocation={location => update("repository", location)} /><S3Setup key={`s3:${profile.id}`} useLocation={location => update("repository", location)} /><div className="form-grid"><label>Session password<input type="password" autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setRepositoryMissing(false); setPreview(""); }} /></label><label>Password file (takes priority)<input placeholder="Created automatically, or enter an existing file" value={profile.passwordFile} onChange={e => update("passwordFile", e.target.value)} /></label></div><button disabled={!password} onClick={() => void createPasswordFile()}>Create password file</button><p>Save the session password to a private file and use it for this profile. Existing files are never overwritten.</p><p>Use an absolute local path or a restic backend URL. Remote storage credentials are inherited from the app’s environment. URLs, paths and profile settings are stored unencrypted; avoid embedding credentials in a repository URL.</p><div className="actions"><button className="primary" disabled={!profile.repository.trim() || !(password || profile.passwordFile.trim())} onClick={() => void refresh()}>{connected ? "Refresh repository" : "Connect"}</button>
                    {repositoryMissing && <button onClick={async () => {
                        if (!window.confirm(`Initialize a new encrypted repository at ${profile.repository}? Keep a safe copy of your password.`)) return;
                        setRepositoryMissing(false);
                        if (await run("init")) await refresh();
                    }}>Initialize new repository</button>}
                    <button onClick={() => { setPassword(""); setRepositoryMissing(false); }}>Clear session password</button>{profiles.length > 1 && <button className="danger" onClick={() => void removeProfile()}>Remove profile</button>}</div></section>}
                {tab === "Backup" && <section className="card form-card"><h2>Create a backup</h2><label>Source paths · one absolute path per line<textarea rows={5} placeholder={"/home/you/Documents\n/home/you/Pictures"} value={profile.sources} onChange={e => update("sources", e.target.value)} /></label><div className="form-grid"><label>Exclude patterns · one per line<textarea rows={4} placeholder={"*.tmp\n**/node_modules"} value={profile.excludes} onChange={e => update("excludes", e.target.value)} /></label><label>Tags · one per line<textarea rows={4} placeholder={"documents\nmanual"} value={profile.tags} onChange={e => update("tags", e.target.value)} /></label></div><label className="checkbox"><input type="checkbox" role="switch" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /> Dry run · preview without creating a snapshot</label><div className="actions"><button className="primary" onClick={() => void run("backup", { dryRun })}>{dryRun ? "Preview backup" : "Back up now"} ↑</button></div><p>Sources must exist on this computer. Snapshots reload automatically after a backup.</p></section>}
                {tab === "Snapshots" && <section className="card">
                    <div className="card-heading">
                        <h2>Snapshot history <span className="count">{snapshots.length}</span></h2>
                        <input aria-label="Filter snapshots" placeholder="Filter by host, path, tag or ID…" value={query} onChange={e => setQuery(e.target.value)} />
                    </div>
                    {!filtered.length ? <div className="empty">{connected ? "No matching snapshots. Create a backup to get started." : "Connect to your repository to load its snapshots."}</div> :
                        <div className="table-scroll snapshot-history-list" role="region" aria-label="Snapshot history" tabIndex={0}>
                            <table>
                                <thead><tr><th>Snapshot</th><th>Created</th><th>Host / sources</th><th>Tags</th><th>Actions</th></tr></thead>
                                <tbody>{filtered.map(snapshot => {
                                    const label = snapshot.short_id || snapshot.id.slice(0, 8);
                                    const isMounted = mounted?.repository === profile.repository && mounted.snapshot === snapshot.id;
                                    return <tr key={snapshot.id} className={selected === snapshot.id ? "selected" : ""}>
                                        <td><code>{label}</code></td>
                                        <td>{new Date(snapshot.time).toLocaleString()}</td>
                                        <td>{snapshot.hostname}<small>{snapshot.paths.join(", ")}</small></td>
                                        <td>{snapshot.tags?.join(", ") || "—"}</td>
                                        <td><div className="snapshot-actions">
                                            <button type="button" title="Browse / restore" aria-label={`Browse or restore snapshot ${label}`} onClick={() => { setSelected(snapshot.id); setBrowserOpen(true); }}>
                                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                                            </button>
                                            <button type="button" title={isMounted ? "Snapshot mounted" : "Mount snapshot"} aria-label={isMounted ? `Snapshot ${label} is mounted` : `Mount snapshot ${label}`} disabled={!connected || isMounted} onClick={() => void mountAction("start", snapshot.id)}>
                                                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M12 11V3m-4 4 4-4 4 4M16 17.5h2" /></svg>
                                            </button>
                                            <button type="button" className="danger" title="Delete snapshot" aria-label={`Delete snapshot ${label}`} disabled={!connected || mounted?.repository === profile.repository} onClick={() => void deleteSnapshot(snapshot)}>
                                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>
                                            </button>
                                        </div></td>
                                    </tr>;
                                })}</tbody>
                            </table>
                        </div>}
                </section>}
                {tab === "Maintenance" && <><section className="card form-card"><h2>Automatic maintenance</h2>
                    <label className="checkbox"><input type="checkbox" role="switch" checked={!!profile.maintenance} onChange={e => update("maintenance", e.target.checked ? { ...policy, readData: false } : undefined)} />After each successful backup: check integrity, apply retention, then prune</label>
                    <p>Applies to manual and scheduled backups. Dry runs and unsuccessful backups skip maintenance. A failed step stops the remaining steps. Settings save automatically for this repository.</p>
                    {profile.maintenance && <>
                        <label className="checkbox"><input type="checkbox" role="switch" checked={profile.maintenance.readData} onChange={e => update("maintenance", { ...profile.maintenance!, readData: e.target.checked })} />Read all backup data during the integrity check</label>
                        <div className="retention-grid">{(["keepLast", "keepDaily", "keepWeekly", "keepMonthly"] as const).map((key, i) => <label key={key}>{["Keep last", "Daily", "Weekly", "Monthly"][i]}<input type="number" min="0" max="10000" value={profile.maintenance![key]} onChange={e => update("maintenance", { ...profile.maintenance!, [key]: Math.max(0, Math.min(10000, Math.trunc(Number(e.target.value)))) })} /></label>)}</div>
                        <p className="result-warning">Automatic retention deletes snapshots outside this policy; pruning reclaims their unused storage. Keep at least one retention count above zero.</p>
                    </>}
                </section><section className="card form-card"><h2>Verify repository</h2><p>Structural checks validate repository metadata. Reading all data also validates stored pack contents and can take much longer.</p><label className="checkbox"><input type="checkbox" role="switch" checked={readData} onChange={e => setReadData(e.target.checked)} /> Read and verify all stored data</label><button onClick={() => void run("check", { readData })}>Run integrity check</button></section><section className="card form-card"><h2>Snapshot retention</h2><p>Keep recovery points per host and source-path group. Preview the policy before removing any snapshots.</p><div className="retention-grid">{(Object.keys(policy) as (keyof typeof policy)[]).map((k, i) => <label key={k}>{["Keep last", "Daily", "Weekly", "Monthly"][i]}<input type="number" min="0" max="10000" value={policy[k]} onChange={e => { setPolicy({ ...policy, [k]: Math.max(0, Math.min(10000, Math.trunc(Number(e.target.value)))) }); setPreview(""); }} /></label>)}</div><div className="actions"><button onClick={async () => { const r = await run("forget", { dryRun: true }); setPreview(r ? policyKey : ""); setConfirmation(""); }}>Preview retention</button><label>Type FORGET to confirm<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label><button className="danger" disabled={preview !== policyKey || confirmation !== "FORGET"} onClick={async () => { const r = await run("forget"); setPreview(""); setConfirmation(""); if (r) { setSnapshots([]); setSelected(""); setBrowserOpen(false); setStats(null); setConnected(false); } }}>Apply retention</button></div></section><section className="card form-card"><h2>Reclaim unused storage</h2><p>Prune permanently removes data no longer referenced by snapshots. Run after reviewing and applying retention.</p><button className="danger" onClick={() => { if (window.prompt("Permanently reclaim unused data? Type PRUNE to continue.") === "PRUNE") void run("prune", { confirmation: "PRUNE" }); }}>Prune repository</button></section></>}
            </fieldset>
            {tab === "Logs" && <>
                <section className="card output-card"><h2>Operation output</h2>
                    <OperationOutput output={output} empty="Command output will appear here when an operation finishes." />
                </section>
                {activity.length > 0 && <section className="card"><h2>Recent operations</h2>
                    {activity.map((a, i) => <div className="activity" key={i}><span>{a.time} · {a.operation}</span><span className={`result-${a.tone}`}>{a.result}</span></div>)}
                </section>}
            </>}
            {(tab === "Backup" || tab === "Logs") && <SchedulePanel key={profile.id} profile={profile} busy={!!busy} beforeSave={flushScheduleProfiles} showLogs={tab === "Logs"} openLogs={() => navigate("Logs")} />}
            <footer>rbackup · Backup Manager for Restic <span>Local control · Encrypted storage · Verified recovery</span></footer>
            </div>
            {browserOpen && chosen && <SnapshotBrowser key={`${active}:${chosen.id}:${mounted?.snapshot === chosen.id && mounted.repository === profile.repository ? mounted.path : "repository"}`} snapshot={chosen}
                loadDirectory={loadDirectory} busy={!!busy} mountBusy={mountBusy}
                mountError={mountError} unmount={mounted ? () => void mountAction("stop") : undefined} cancel={cancelOperation} cancelling={cancelling} mountedPath={mounted?.snapshot === chosen.id && mounted.repository === profile.repository ? mounted.path : undefined} mount={() => void mountAction("start", chosen.id)}
                restore={async (restorePaths, destination) => !!await run("restore", { snapshot: chosen.id, target: destination, restorePaths }, true)}
                close={() => { if (listing) void invoke("cancel_restic").catch(() => { }); setBrowserOpen(false); }} />}
        </main>
    </div>;
}
export default App;
