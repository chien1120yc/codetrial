import assert from "node:assert/strict";
import test from "node:test";
import { loadInterview } from "./source.js";

function setup({ isGuest = false, savedToAccount = false, deleteReport }) {
  const calls = [];
  const alerts = [];
  const guardChanges = [];
  const beforeUnloadGuard = {
    setEnabled(enabled) {
      guardChanges.push(enabled);
    },
  };
  const state = {
    isGuest,
    savedToAccount,
    reportId: "report-123",
    skipCleanupPending: false,
  };
  const nodes = {
    ending: { hidden: true },
    skipReport: { hidden: true, textContent: "" },
    endingDetail: { textContent: "" },
  };
  const window = {
    location: { href: "/interview" },
    alert(message) {
      alerts.push(message);
    },
  };
  const saveHistory = { pending: new Set() };

  const { finishSkippedReportCleanup } = loadInterview(
    ["finishSkippedReportCleanup"],
    {
      state,
      nodes,
      window,
      saveHistory,
      beforeUnloadGuard,
      deleteReport: async (...args) => {
        calls.push(args);
        return deleteReport(...args);
      },
      console: { warn() {} },
    },
  );

  return {
    finishSkippedReportCleanup,
    state,
    nodes,
    window,
    saveHistory,
    calls,
    alerts,
    guardChanges,
  };
}

test("render failure hides Skip without removing safe exits", () => {
  for (const offlineSummary of [false, true]) {
    const events = [];
    const state = {
      phase: "report",
      reportReceiving: true,
      reportUnreadable: false,
    };
    const nodes = {
      report: { hidden: false },
      ending: { hidden: true },
      skipReport: { hidden: false },
      endingDetail: { textContent: "" },
      leaveRoom: { hidden: true },
      forceReport: { hidden: true },
    };
    const { reportRenderFailed } = loadInterview(["reportRenderFailed"], {
      state,
      nodes,
      console: { warn: () => events.push("warn") },
      stopEndingClock: () => events.push("stop-clock"),
      stopEndingEscape: () => events.push("stop-escape"),
      providerUiState: (kind) => ({ message: kind }),
    });

    reportRenderFailed(new Error("render failed"), { offlineSummary });

    assert.equal(state.phase, "ending");
    assert.equal(state.reportUnreadable, true);
    assert.equal(state.reportReceiving, false);
    assert.equal(nodes.report.hidden, true);
    assert.equal(nodes.ending.hidden, false);
    assert.equal(nodes.skipReport.hidden, true);
    assert.equal(nodes.leaveRoom.hidden, false);
    assert.equal(nodes.forceReport.hidden, !offlineSummary);
    assert.equal(
      nodes.endingDetail.textContent,
      offlineSummary ? "report_unreadable" : "report_undrawable",
    );
    assert.deepEqual(events, ["warn", "stop-clock", "stop-escape"]);
  }
});

test("guest exits without attempting report deletion", async () => {
  const ctx = setup({
    isGuest: true,
    deleteReport: async () => {
      throw new Error("Guest must not call deleteReport");
    },
  });

  await ctx.finishSkippedReportCleanup();

  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.window.location.href, "/");
  assert.deepEqual(ctx.guardChanges, [false]);
  assert.equal(ctx.state.skipCleanupPending, false);
  assert.deepEqual(ctx.alerts, []);
});

test("failed account cleanup blocks exit and succeeds on retry", async () => {
  let attempts = 0;
  const ctx = setup({
    savedToAccount: true,
    deleteReport: async () => {
      attempts += 1;
      return attempts === 1 ? "failed" : "deleted";
    },
  });

  await ctx.finishSkippedReportCleanup();

  assert.equal(ctx.window.location.href, "/interview");
  assert.equal(ctx.nodes.skipReport.hidden, false);
  assert.equal(ctx.nodes.skipReport.textContent, "Retry cleanup and exit");
  assert.equal(ctx.state.skipCleanupPending, false);
  assert.equal(ctx.alerts.length, 1);
  assert.deepEqual(ctx.guardChanges, [true]);
  assert.match(ctx.nodes.endingDetail.textContent, /sign in again/);
  assert.deepEqual(ctx.calls, [["report-123", { account: true }]]);

  await ctx.finishSkippedReportCleanup();

  assert.equal(ctx.window.location.href, "/");
  assert.equal(ctx.state.skipCleanupPending, false);
  assert.deepEqual(ctx.calls, [
    ["report-123", { account: true }],
    ["report-123", { account: true }],
  ]);
  assert.deepEqual(ctx.guardChanges, [true, false]);
});

test("cleanup waits for an in-flight history save before deletion", async () => {
  let finishSave;
  const saving = new Promise((resolve) => {
    finishSave = resolve;
  });
  const ctx = setup({
    savedToAccount: true,
    deleteReport: async () => "deleted",
  });
  ctx.saveHistory.pending.add(saving);

  const cleanup = ctx.finishSkippedReportCleanup();

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.window.location.href, "/interview");

  finishSave();
  await cleanup;

  assert.deepEqual(ctx.calls, [["report-123", { account: true }]]);
  assert.equal(ctx.window.location.href, "/");
});

test("former account session cannot abandon a saved account report", async () => {
  const ctx = setup({
    isGuest: true,
    savedToAccount: true,
    deleteReport: async () => "failed",
  });

  await ctx.finishSkippedReportCleanup();

  assert.deepEqual(ctx.calls, [["report-123", { account: true }]]);
  assert.equal(ctx.window.location.href, "/interview");
  assert.equal(ctx.nodes.skipReport.hidden, false);
  assert.equal(ctx.nodes.skipReport.textContent, "Retry cleanup and exit");
  assert.equal(ctx.alerts.length, 1);
  assert.deepEqual(ctx.guardChanges, [true]);
  assert.match(ctx.nodes.endingDetail.textContent, /sign in again/);
});

test("skip while board upload is pending prevents end publication", async () => {
  let finishUpload;
  const uploadPending = new Promise((resolve) => {
    finishUpload = resolve;
  });

  const published = [];
  const sent = [];
  const state = {
    phase: "live",
    reportReceiving: false,
    language: "en",
    connected: true,
    room: { disconnect: async () => {} },
    skipCleanupPending: false,
  };
  const nodes = {
    frameworkHint: { hidden: false },
    end: { disabled: false },
    ending: { hidden: true },
    forceReport: { hidden: true },
  };

  const scope = {
    state,
    nodes,
    strict: false,
    exampleBoard: null,
    whiteboard: true,
    board: {
      settle: null,
      unsentSince: 0,
      model: { end() {} },
    },
    codePublishTimer: null,
    pendingLanguagePublish: null,
    frameworkHintTimer: null,
    roomParticipants: () => [],
    roomInterviewer: () => false,
    topics: { control: "control" },
    currentCode: () => "",
    endInterviewPayload: () => ({ type: "end_interview" }),
    skipReportPayload: () => ({ type: "skip_report" }),
    boardUploadsSettled: () => uploadPending,
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
    sendData: async (topic, payload) => {
      sent.push({ topic, payload });
    },
    window: { confirm: () => true },
    reportRecovery: { stop() {} },
    beforeUnloadGuard: { dispose() {} },
    recordReplay() {},
    flushReplay: async () => {},
    flushPendingBoardCheckpoints() {},
    recordBoardOps() {},
    queueBoardPublish() {},
    clearCandidateCases() {},
    startEndingClock() {},
    stopEndingEscape() {},
    stopEndingClock() {},
    stopAvatar() {},
    stopLocalMedia() {},
    finishSkippedReportCleanup: async () => {},
    showReport() {},
    setTimeout: () => 0,
  };

  const { endInterview, skipReportAndExit } = loadInterview(
    ["endInterview", "skipReportAndExit"],
    scope,
  );

  endInterview("candidate_ended");

  assert.equal(state.phase, "ending");
  assert.equal(published.length, 0);

  await skipReportAndExit();

  assert.equal(state.phase, "skipped");
  assert.deepEqual(
    sent.map(({ payload }) => payload.type),
    ["skip_report"],
  );

  finishUpload();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(published, []);
});

test("skip during reconnection publishes after reconnecting", async () => {
  const sent = [];
  const listeners = new Map();

  const room = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    off(event, listener) {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
    async disconnect() {},
  };

  const state = {
    phase: "ending",
    connected: false,
    room,
    skipCleanupPending: false,
  };

  const scope = {
    state,
    livekit: {
      RoomEvent: {
        Reconnected: "reconnected",
      },
    },
    topics: { control: "control" },
    skipReportPayload: () => ({ type: "skip_report" }),
    sendData: async (topic, payload) => {
      sent.push({ topic, payload });
    },
    window: {
      confirm: () => true,
      LivekitClient: {
        RoomEvent: { Reconnected: "reconnected" },
      },
    },
    reportRecovery: { stop() {} },
    stopEndingEscape() {},
    stopEndingClock() {},
    beforeUnloadGuard: { dispose() {} },
    stopAvatar() {},
    stopLocalMedia() {},
    finishSkippedReportCleanup: async () => {},
    console: { warn() {} },
    setTimeout,
    clearTimeout,
  };

  const { skipReportAndExit } = loadInterview(["skipReportAndExit"], scope);

  const skipping = skipReportAndExit();

  assert.deepEqual(sent, []);
  assert.equal(listeners.has("reconnected"), true);

  state.connected = true;
  listeners.get("reconnected")();

  await skipping;

  assert.deepEqual(sent, [
    { topic: "control", payload: { type: "skip_report" } },
  ]);
  assert.equal(listeners.has("reconnected"), false);
  assert.equal(state.room, null);
});

test("skip during reconnection times out and still cleans up", async () => {
  const listeners = new Map();
  const warnings = [];
  let disconnected = false;
  let cleanedUp = false;
  let sent = false;
  let expirePublication;

  const room = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    off(event, listener) {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
    async disconnect() {
      disconnected = true;
    },
  };

  const state = {
    phase: "ending",
    connected: false,
    room,
    skipCleanupPending: false,
  };

  const { skipReportAndExit } = loadInterview(["skipReportAndExit"], {
    state,
    livekit: {
      RoomEvent: { Reconnected: "reconnected" },
    },
    topics: { control: "control" },
    skipReportPayload: () => ({ type: "skip_report" }),
    sendData: async () => {
      sent = true;
    },
    window: {
      confirm: () => true,
      LivekitClient: {
        RoomEvent: { Reconnected: "reconnected" },
      },
    },
    reportRecovery: { stop() {} },
    stopEndingEscape() {},
    stopEndingClock() {},
    beforeUnloadGuard: { dispose() {} },
    stopAvatar() {},
    stopLocalMedia() {},
    finishSkippedReportCleanup: async () => {
      cleanedUp = true;
    },
    console: {
      warn(...args) {
        warnings.push(args);
      },
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 5000);
      expirePublication = callback;
      return 1;
    },
    clearTimeout() {},
  });

  const skipping = skipReportAndExit();

  assert.equal(listeners.has("reconnected"), true);
  assert.equal(sent, false);

  expirePublication();
  await skipping;

  assert.equal(sent, false);
  assert.equal(disconnected, true);
  assert.equal(cleanedUp, true);
  assert.equal(state.room, null);
  assert.equal(listeners.has("reconnected"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "codetrial skip_report_publish_failed");
});
