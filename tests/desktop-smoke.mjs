import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const elementKey = "element-6066-11e4-a52e-4f735466cecf";

async function freePort() {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitFor(description, read) {
    const deadline = Date.now() + 25_000;
    do {
        const value = await read();
        if (value) return value;
        await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for ${description}`);
}

test("desktop preview, backup, and selected-file restore with real Restic", async t => {
    assert.equal(process.platform, "linux", "This smoke test uses the Linux WebKitWebDriver.");
    const application = resolve(process.env.RBACKUP_TEST_APP ?? "src-tauri/target/debug/rbackup");
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "rbackup-desktop-")));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const source = join(fixture, "source");
    const repository = join(fixture, "repository");
    const passwordFile = join(fixture, "password");
    const destination = join(fixture, "restore");
    await mkdir(source);
    const selectedFile = join(source, "selected.txt");
    const otherFile = join(source, "other.txt");
    await writeFile(selectedFile, "desktop smoke test bytes\n");
    await writeFile(otherFile, "do not restore me\n");
    await writeFile(passwordFile, "disposable test password", { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RESTIC_")));
    Object.assign(env, {
        HOME: fixture, XDG_CONFIG_HOME: join(fixture, "config"), XDG_DATA_HOME: join(fixture, "data"),
        XDG_CACHE_HOME: join(fixture, "cache"), XDG_STATE_HOME: join(fixture, "state"),
    });
    const restic = (...args) => execFileSync("restic", ["--repo", repository, "--password-file", passwordFile, "--json", ...args], { env, encoding: "utf8", timeout: 25_000 });
    restic("init");
    const port = await freePort();
    let nativePort = await freePort();
    while (nativePort === port) nativePort = await freePort();
    const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(nativePort)], { env, stdio: "inherit" });
    const driverExit = new Promise(resolve => {
        driver.once("error", resolve);
        driver.once("exit", (code, signal) => resolve(new Error(`tauri-driver exited (${code ?? signal})`)));
    });
    let session;
    const call = async (path, method = "GET", body) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        const { value } = await response.json();
        if (!response.ok) throw new Error(value.message, { cause: value.error });
        return value;
    };
    const command = (path, method, body) => call(`/session/${session}${path}`, method, body);
    const execute = (script, ...args) => command("/execute/sync", "POST", { script, args });
    const click = async (using, value) => {
        const elements = await waitFor(value, async () => {
            const found = await command("/elements", "POST", { using, value });
            return found.length ? found : null;
        });
        await command(`/element/${elements[0][elementKey]}/click`, "POST", {});
    };
    const button = name => click("xpath", `//main//button[starts-with(normalize-space(.), "${name}") and not(@disabled)]`);
    const nav = name => click("xpath", `//aside[contains(@class,"desktop-sidebar")]//button[contains(normalize-space(.), "${name}")]`);
    const status = text => waitFor(text, () => execute('return document.querySelector("main .status.visible")?.textContent.includes(arguments[0])', text));

    try {
        await Promise.race([
            waitFor("WebDriver server", () => call("/status").then(result => result.ready).catch(() => false)),
            driverExit.then(error => { throw error; }),
        ]);
        const result = await call("/session", "POST", {
            capabilities: { alwaysMatch: { "tauri:options": { application } } },
        });
        session = result.sessionId;
        await command("/window/rect", "POST", { width: 1100, height: 760 });
        await waitFor("workspace", () => execute('return !!document.querySelector(".profile-bar")'));
        await execute(`localStorage.setItem("restic-profiles", JSON.stringify([arguments[0]]));`, {
            id: "desktop-smoke", name: "Desktop smoke", repository, passwordFile, sources: source, excludes: "", tags: "",
        });
        await command("/refresh", "POST", {});
        await status("Repository connected.");
        await nav("Backup");
        await button("Preview backup");
        await status("No snapshot was created.");
        assert.deepEqual(JSON.parse(restic("snapshots")) ?? [], []);

        await click("css selector", 'main .form-card input[role="switch"]');
        await button("Back up now");
        await status("Backup completed.");
        assert.equal(JSON.parse(restic("snapshots")).length, 1);
        await nav("Logs");
        await waitFor("backup summary in Logs", () => execute('return !!document.querySelector(".output-card pre")?.textContent.includes("Summary")'));

        await rm(selectedFile);
        await rm(otherFile);
        await nav("Snapshots");
        await click("css selector", 'button[title="Browse / restore"]');
        for (const path of source.slice(1).split("/").map((_, i, parts) => "/" + parts.slice(0, i + 1).join("/"))) {
            await click("css selector", `[data-tree-path="${path}"][aria-expanded="false"] > .tree-row .tree-toggle`);
        }
        await click("css selector", `[data-tree-path="${selectedFile}"] > .tree-row input[type="checkbox"]`);
        const input = await command("/element", "POST", { using: "css selector", value: ".browser-restore input" });
        await command(`/element/${input[elementKey]}/value`, "POST", { text: destination });
        await click("xpath", '//dialog//button[normalize-space(.)="Restore selected" and not(@disabled)]');
        await waitFor("verified restore", () => execute('return !!document.querySelector(".browser-restore .result-success")'));
        assert.equal(await readFile(join(destination, selectedFile.slice(1)), "utf8"), "desktop smoke test bytes\n");
        await assert.rejects(readFile(join(destination, otherFile.slice(1))), { code: "ENOENT" });
    } finally {
        if (session) await command("", "DELETE").catch(() => {});
        driver.kill();
        await driverExit;
    }
});
