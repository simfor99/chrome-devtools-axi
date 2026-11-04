import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  createBridgeServer,
  type BridgeClient,
  type BridgeToolDescription,
} from "../src/bridge.js";
import { callTool, callToolViaBridge, CdpError } from "../src/client.js";
import { OwnedPageRouter } from "../src/owned-pages.js";

const ownerA = "fixture-task-alpha";
const ownerB = "fixture-task-bravo";
const schema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

interface FakePage {
  id: number;
  url: string;
  selected: boolean;
  isolatedContext?: string;
}

function fixture() {
  const pages = new Map<number, FakePage>([
    [99, { id: 99, url: "about:blank", selected: true }],
  ]);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let nextId = 0;
  let failNew = false;
  let noClose = false;
  let ambiguous = false;
  const tools: BridgeToolDescription[] = [
    { name: "list_pages", inputSchema: schema({}) },
    {
      name: "new_page",
      inputSchema: schema({ url: {}, background: {}, isolatedContext: {} }),
    },
    ...[
      "select_page",
      "close_page",
      "take_snapshot",
      "evaluate_script",
      "arbitrary_future_page_tool",
    ].map((name) => ({
      name,
      inputSchema: schema({ pageId: { type: "number" } }),
    })),
    { name: "implicit_legacy_snapshot", inputSchema: schema({}) },
  ];
  const listing = () => ({
    content: [
      {
        type: "text",
        text: [...pages.values()]
          .map(
            (p) =>
              `${p.id}: ${p.url}${p.selected ? " [selected]" : ""}${p.isolatedContext ? ` isolatedContext=${p.isolatedContext}` : ""}`,
          )
          .join("\n"),
      },
    ],
    structuredContent: { pages: [...pages.values()] },
  });
  const client: BridgeClient = {
    async listTools() {
      return { tools };
    },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args: structuredClone(args) });
      if (name === "list_pages") return listing();
      if (name === "new_page") {
        const id = nextId++;
        pages.set(id, {
          id,
          url: String(args.url ?? "about:blank"),
          selected: false,
          isolatedContext: args.isolatedContext as string | undefined,
        });
        if (ambiguous) {
          pages.set(50, {
            id: 50,
            url: "about:blank",
            selected: false,
            isolatedContext: args.isolatedContext as string | undefined,
          });
        }
        return { ...listing(), isError: failNew };
      }
      const pageId = args.pageId as number;
      assert.ok(pages.has(pageId), "Physical page target exists");
      if (name === "close_page") {
        if (!noClose) pages.delete(pageId);
        return listing();
      }
      if (name === "select_page") {
        for (const p of pages.values()) p.selected = p.id === pageId;
        return listing();
      }
      return { content: [{ type: "text", text: `own-page-${pageId}` }] };
    },
    async close() {},
  };
  const router = new OwnedPageRouter(client);
  const call = (
    name: string,
    args: Record<string, unknown> = {},
    owner = ownerA,
    bridgeId = router.bridgeId,
  ) => router.run({ name, args, owner, bridgeId });
  const create = (owner = ownerA) =>
    call("new_page", { url: "about:blank" }, owner);
  const physical = (name: string) => calls.filter((c) => c.name === name);
  return {
    pages,
    calls,
    tools,
    client,
    router,
    call,
    create,
    physical,
    set failNew(value: boolean) {
      failNew = value;
    },
    set noClose(value: boolean) {
      noClose = value;
    },
    set ambiguous(value: boolean) {
      ambiguous = value;
    },
  };
}

describe("OwnedPageRouter", () => {
  beforeEach(() => {
    for (const key of [
      "CHROME_DEVTOOLS_AXI_BROWSER_URL",
      "CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
      "CHROME_DEVTOOLS_AXI_USER_DATA_DIR",
      "CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT",
      "CHROME_DEVTOOLS_AXI_OWNER_ID",
      "CHROME_DEVTOOLS_AXI_REQUIRE_OWNER",
    ]) {
      vi.stubEnv(key, "");
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Actual inputSchema routes arbitrary future tools, snapshot/eval and ID zero; caller args untouched", async () => {
    const f = fixture();
    await f.create(ownerA);
    const original = { function: "() => document.title" };
    await f.call("take_snapshot");
    await f.call("evaluate_script", original);
    await f.call("arbitrary_future_page_tool");
    for (const name of [
      "take_snapshot",
      "evaluate_script",
      "arbitrary_future_page_tool",
    ]) {
      assert.equal(f.physical(name)[0].args.pageId, 0);
    }
    assert.deepEqual(original, { function: "() => document.title" });
    const creation = f.physical("new_page")[0].args;
    assert.equal(creation.background, true);
    assert.match(String(creation.isolatedContext), /^axi-owned-/);
    assert.equal(f.pages.get(99)?.selected, true);
  });

  it("Two callers never inherit shared backend selection; foreign page denied before physical operation", async () => {
    const f = fixture();
    await f.create(ownerA);
    await f.create(ownerB);
    await f.call("select_page", { pageId: 1 }, ownerB);
    assert.deepEqual(f.physical("select_page")[0].args, {
      pageId: 1,
      bringToFront: false,
    });
    await f.call("take_snapshot", {}, ownerA);
    await f.call("take_snapshot", {}, ownerB);
    assert.deepEqual(
      f.physical("take_snapshot").map((c) => c.args.pageId),
      [0, 1],
    );
    for (const name of ["select_page", "close_page", "evaluate_script"]) {
      const count = f.physical(name).length;
      await assert.rejects(
        f.call(name, { pageId: 1 }, ownerA),
        /another task/,
      );
      assert.equal(f.physical(name).length, count);
    }
    assert.equal(f.pages.get(99)?.url, "about:blank");
  });

  it("Missing, nonnumeric, fractional, negative, unsafe, conflicting and stale bridge IDs fail closed", async () => {
    const f = fixture();
    await assert.rejects(
      f.call("new_page", { url: "about:blank" }, ""),
      /Explicit task owner/,
    );
    await assert.rejects(f.call("take_snapshot"), /Missing or invalid/);
    await f.create(ownerA);
    await f.create(ownerA);
    for (const pageId of ["0", NaN, 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        f.call("evaluate_script", { pageId }),
        /invalid/,
      );
    }
    await assert.rejects(
      f.call("evaluate_script", { pageId: 0 }),
      /conflicts/,
    );
    await assert.rejects(
      f.call("evaluate_script", {}, ownerA, "old-instance"),
      /Stale/,
    );
    assert.equal(f.physical("evaluate_script").length, 0);
  });

  it("External close, closed owner page and recycled ID from a foreign context deny physical accesses", async () => {
    const f = fixture();
    await f.create(ownerA);
    f.pages.delete(0);
    await assert.rejects(f.call("take_snapshot"), /stale or closed/);
    assert.equal(f.physical("take_snapshot").length, 0);
    await f.create(ownerA);
    f.pages.set(1, {
      id: 1,
      url: "about:blank",
      selected: true,
      isolatedContext: "foreign",
    });
    await assert.rejects(f.call("take_snapshot"), /stale or closed/);
    assert.equal(f.physical("take_snapshot").length, 0);
  });

  it("Successful close invalidates selection; unsuccessful close retains cleanup authority", async () => {
    const f = fixture();
    await f.create(ownerA);
    f.noClose = true;
    await assert.rejects(f.call("close_page", { pageId: 0 }), /not closed/);
    f.noClose = false;
    await f.call("close_page", { pageId: 0 });
    await assert.rejects(f.call("take_snapshot"), /Missing or invalid/);
    await assert.rejects(f.call("select_page", { pageId: 0 }), /another task/);
    assert.equal(f.pages.has(99), true);
  });

  it("Foreground, alternate worker and context override denied; legacy implicit routing has no fallback", async () => {
    const f = fixture();
    await f.create(ownerA);
    await assert.rejects(
      f.call("select_page", { pageId: 0, bringToFront: true }),
      /Foreground/,
    );
    await assert.rejects(
      f.call("evaluate_script", { serviceWorkerId: 1 }),
      /Service-worker/,
    );
    await assert.rejects(
      f.call("new_page", { url: "about:blank", background: false }),
      /Foreground/,
    );
    await assert.rejects(
      f.call("new_page", { url: "about:blank", isolatedContext: "foreign" }),
      /override/,
    );
    await assert.rejects(
      f.call("implicit_legacy_snapshot"),
      /implicit browser targets/,
    );
    await assert.rejects(
      f.call("unregistered_page_tool"),
      /inputSchema unavailable/,
    );
    assert.equal(
      f.physical("select_page").length + f.physical("evaluate_script").length,
      0,
    );
    assert.equal(f.physical("new_page").length, 1);
  });

  it("Ambiguous creation grants no ownership; returned error retains exact created page cleanup", async () => {
    const f = fixture();
    f.ambiguous = true;
    await assert.rejects(f.create(ownerA), /identity ambiguous/);
    await assert.rejects(f.call("take_snapshot"), /Missing or invalid/);
    const g = fixture();
    g.failNew = true;
    await assert.rejects(
      g.create(ownerA),
      /owned page 0 requires cleanup|page 0 retained for cleanup only/,
    );
    await g.call("close_page", { pageId: 0 });
    assert.equal(g.pages.has(0), false);
  });

  it("Attached persistent browser (CHROME_DEVTOOLS_AXI_BROWSER_URL) uses default logged-in profile context while enforcing strict pageId ownership", async () => {
    const priorUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    const priorIso = process.env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://172.22.16.1:9223";
    delete process.env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT;
    try {
      const f = fixture();
      await f.create(ownerA);
      const creation = f.physical("new_page")[0].args;
      assert.equal(creation.background, true);
      assert.equal(creation.isolatedContext, undefined);
      await f.call("take_snapshot", {}, ownerA);
      assert.equal(f.physical("take_snapshot")[0].args.pageId, 0);
      await assert.rejects(
        f.call("select_page", { pageId: 99 }, ownerA),
        /another task/,
      );
      await assert.rejects(
        f.call("close_page", { pageId: 99 }, ownerA),
        /another task/,
      );
      await f.call("close_page", { pageId: 0 }, ownerA);
      assert.equal(f.pages.has(0), false);
      assert.equal(f.pages.has(99), true);
    } finally {
      if (priorUrl === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = priorUrl;
      }
      if (priorIso === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT = priorIso;
      }
    }
  });

  it("Concurrent callers serialize creation identity attribution and preserve separate contexts", async () => {
    const f = fixture();
    await Promise.all([f.create(ownerA), f.create(ownerB)]);
    await Promise.all([
      f.call("evaluate_script", {}, ownerA),
      f.call("evaluate_script", {}, ownerB),
    ]);
    assert.deepEqual(
      f.physical("evaluate_script").map((c) => c.args.pageId),
      [0, 1],
    );
    assert.notEqual(
      f.pages.get(0)?.isolatedContext,
      f.pages.get(1)?.isolatedContext,
    );
  });

  it("Actual HTTP bridge preserves inputSchema and shared client injects snapshot/eval owned ID", async () => {
    const f = fixture();
    const server = createBridgeServer(f.client);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const tools = (await (
        await fetch(`http://127.0.0.1:${port}/tools`)
      ).json()) as BridgeToolDescription[];
      assert.deepEqual(
        tools.find((t) => t.name === "evaluate_script")?.inputSchema,
        f.tools.find((t) => t.name === "evaluate_script")?.inputSchema,
      );
      await callToolViaBridge(port, ownerA, "new_page", { url: "about:blank" });
      assert.equal(
        await callToolViaBridge(port, ownerA, "take_snapshot"),
        "own-page-0",
      );
      assert.equal(
        await callToolViaBridge(port, ownerA, "evaluate_script", {
          function: "() => 1",
        }),
        "own-page-0",
      );
      await assert.rejects(
        callToolViaBridge(port, ownerB, "evaluate_script", { pageId: 0 }),
        /another task/,
      );
      const stale = await fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        body: JSON.stringify({
          name: "take_snapshot",
          args: {},
          owner: ownerA,
          bridgeId: "stale",
        }),
      });
      assert.equal(stale.status, 500);
      assert.equal(f.physical("take_snapshot").length, 1);
      await callToolViaBridge(port, ownerA, "close_page", { pageId: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Bridge restart cannot inherit an old caller page or accept stale dispatch", async () => {
    const f = fixture();
    await f.create(ownerA);
    const second = new OwnedPageRouter(f.client);
    await assert.rejects(
      second.run({
        name: "take_snapshot",
        args: {},
        owner: ownerA,
        bridgeId: f.router.bridgeId,
      }),
      /Stale/,
    );
    await assert.rejects(
      second.run({
        name: "take_snapshot",
        args: {},
        owner: ownerA,
        bridgeId: second.bridgeId,
      }),
      /Missing or invalid/,
    );
    assert.equal(f.physical("take_snapshot").length, 0);
  });

  it("Public client rejects absent and malformed caller identity before ensureBridge or browser startup", async () => {
    const prior = process.env.CHROME_DEVTOOLS_AXI_OWNER_ID;
    const priorReq = process.env.CHROME_DEVTOOLS_AXI_REQUIRE_OWNER;
    process.env.CHROME_DEVTOOLS_AXI_REQUIRE_OWNER = "1";
    try {
      delete process.env.CHROME_DEVTOOLS_AXI_OWNER_ID;
      await assert.rejects(
        callTool("new_page", { url: "about:blank" }),
        (err: unknown) =>
          err instanceof CdpError && err.code === "OWNER_REQUIRED",
      );
      process.env.CHROME_DEVTOOLS_AXI_OWNER_ID = "invalid space";
      await assert.rejects(
        callTool("evaluate_script", { function: "() => 1" }),
        (err: unknown) =>
          err instanceof CdpError && err.code === "OWNER_REQUIRED",
      );
    } finally {
      if (prior === undefined) delete process.env.CHROME_DEVTOOLS_AXI_OWNER_ID;
      else process.env.CHROME_DEVTOOLS_AXI_OWNER_ID = prior;
      if (priorReq === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_REQUIRE_OWNER;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_REQUIRE_OWNER = priorReq;
      }
    }
  });

  it("Failed new_page in shared default context does not claim a concurrently opened user tab for cleanup", async () => {
    vi.stubEnv("CHROME_DEVTOOLS_AXI_BROWSER_URL", "http://127.0.0.1:9222");
    const f = fixture();
    let listCalls = 0;
    const origCallTool = f.client.callTool.bind(f.client);
    f.client.callTool = async (req, roots) => {
      if (req.name === "list_pages") {
        listCalls += 1;
        if (listCalls === 2) {
          // Simulate user opening tab 77 in default context while new_page failed
          f.pages.set(77, { id: 77, url: "https://user.example", selected: true });
        }
      }
      if (req.name === "new_page") {
        throw new Error("Simulated new_page failure without creating an owned tab");
      }
      return origCallTool(req, roots);
    };
    await assert.rejects(
      f.create(ownerA),
      /New page identity ambiguous; no ownership granted/,
    );
    await assert.rejects(
      f.call("close_page", { pageId: 77 }, ownerA),
      /Page belongs to another task or was not created by this caller/,
    );
  });

  it("Bridge enforces OwnedPageRouter on unowned /call when CHROME_DEVTOOLS_AXI_REQUIRE_OWNER=1", async () => {
    vi.stubEnv("CHROME_DEVTOOLS_AXI_REQUIRE_OWNER", "1");
    const f = fixture();
    const server = createBridgeServer(f.client);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const unownedCall = await fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        body: JSON.stringify({
          name: "take_snapshot",
          args: { pageId: 99 },
        }),
      });
      assert.equal(unownedCall.status, 500);
      const body = (await unownedCall.json()) as { error?: string };
      assert.match(
        String(body.error),
        /Stale or unbound bridge instance|CHROME_DEVTOOLS_AXI_OWNER_ID/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
