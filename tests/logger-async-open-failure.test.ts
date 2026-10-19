import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    configureLogger,
    log,
    closeLogger,
    setLogCapture,
    muteStderrLeg,
    isFileLoggingActive,
    onFileLegLive,
} from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #3857: a refused ASYNC open (EISDIR/EACCES/EPERM) reaches only the stream's
// 'error' event — getStream()'s try/catch sees sync throws (mkdirSync) alone.
// Before the fix that path destroyed the stream in silence: no warn, and a
// #2864-muted child lost BOTH legs. These tests pin the degradation contract.

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr;
    Object.defineProperty(process, "stderr", {
        configurable: true,
        value: { write: (chunk: unknown) => { lines.push(String(chunk)); return true; } },
    });
    return { lines, restore: () => Object.defineProperty(process, "stderr", { configurable: true, value: orig }) };
}

async function until(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function waitForFileLegLive(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("file leg did not become live")), timeoutMs);
        onFileLegLive(() => { clearTimeout(t); resolve(); });
    });
}

// A DIRECTORY at the log-file path: mkdirSync(dirname) succeeds, statSync
// succeeds (a dir's size < 10MB), so createWriteStream's open fails ASYNC with
// EISDIR — deterministic on every platform, unlike chmod-based EACCES.
function dirAsLogPath(root: string): string {
    fs.mkdirSync(root, { recursive: true });
    const p = path.join(root, "bili.log");
    fs.mkdirSync(p);
    return p;
}

test("async open failure degrades with one warn + restored stderr fallback (no silent loss)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(dirAsLogPath(dir));
    try {
        muteStderrLeg(); // launcher-child posture (#2864): file leg believed live
        log("info", "lost-line-1");
        await until(() => warns.length >= 1, "degradation warn");
        log("info", "survivor-line");
        await until(() => cap.lines.some((l) => l.includes("survivor-line")), "stderr fallback line");
        assert.equal(warns.length, 1, "exactly one [warn] per degradation episode");
        assert.ok(warns[0].includes("unavailable"), "warn names the failure reason");
        assert.ok(cap.lines.some((l) => l.includes("[warn]") && l.includes("stderr-only")), "warn lands on the un-muted stderr leg");
        assert.ok(!isFileLoggingActive(), "file leg must not report active after a refused open");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("persistent async failures stay one-shot across the per-line retry loop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    configureLogger(file);
    try {
        await waitForFileLegLive();
        // Under #3857 v2 semantics a VERIFIED OPEN does not arm the one-shot
        // counter — a LANDED write does (Win32 can emit 'open' for an unusable
        // fd). Prove the leg healthy so any earlier episode (test 1's refused
        // open left the flag armed) is closed before we break the file.
        log("info", "arm-line");
        await until(() => fs.statSync(file).size > 0, "armed write flushed");
        await new Promise((r) => setTimeout(r, 50)); // settle the flush-callback reset
        fs.renameSync(file, file + ".bak"); // legal on Windows even while the fd is open
        fs.mkdirSync(file); // path is now a directory → every reopen fails ASYNC (EISDIR)
        for (let i = 0; i < 5; i++) {
            log("info", `retry-loop-${i}`);
            await new Promise((r) => setTimeout(r, 60)); // let this line's doomed stream fail+clear first
        }
        assert.equal(warns.length, 1, "one warn per episode, not one per doomed stream");
        assert.ok(cap.lines.some((l) => l.includes("[warn]")), "the single warn reached stderr");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("onFileLegLive fires exactly once per successful open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    let fires = 0;
    configureLogger(file);
    onFileLegLive(() => { fires++; });
    try {
        await waitForFileLegLive();
        assert.equal(fires, 1, "one fire per verified open");
        assert.equal(isFileLoggingActive(), true);
        log("info", "after-live");
        await until(() => fs.existsSync(file) && fs.statSync(file).size > 0, "file content");
        assert.equal(fires, 1, "no re-fire while the same stream stays open");
    } finally {
        closeLogger();
        rmrf(dir);
    }
});

test("onFileLegLive fires immediately when the leg is already open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        await waitForFileLegLive();
        let fired = false;
        onFileLegLive(() => { fired = true; });
        assert.equal(fired, true, "registration on a live leg must not wait for the next open");
    } finally {
        closeLogger();
        rmrf(dir);
    }
});

test("onFileLegLive never fires when the open is refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const cap = captureStderr();
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    let fires = 0;
    configureLogger(dirAsLogPath(dir));
    onFileLegLive(() => { fires++; });
    try {
        await until(() => warns.length >= 1, "degradation warn");
        assert.equal(fires, 0, "a refused open must never claim the leg is live");
    } finally {
        setLogCapture(null);
        cap.restore();
        closeLogger();
        rmrf(dir);
    }
});

test("isFileLoggingActive requires a verified open (pending stream is not live)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-logger-asyncfail-"));
    const file = path.join(dir, "bili.log");
    configureLogger(file);
    try {
        assert.equal(isFileLoggingActive(), false, "right after configureLogger the open is still in flight");
        await waitForFileLegLive();
        assert.equal(isFileLoggingActive(), true);
    } finally {
        closeLogger();
        rmrf(dir);
    }
});
