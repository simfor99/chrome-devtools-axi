/**
 * Task-owned explicit page routing for chrome-devtools-axi.
 *
 * Enforces per-owner tab isolation (`CHROME_DEVTOOLS_AXI_OWNER_ID`), forbids
 * foreground window/tab activation (`background: false`, `bringToFront: true`),
 * and defaults attached persistent browser sessions
 * (`CHROME_DEVTOOLS_AXI_BROWSER_URL`, `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1`,
 * `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`) to the shared default browser context
 * so background tabs inherit the user's logged-in profile without spawning a
 * second unauthenticated Chrome window, while still strictly enforcing pageId
 * ownership per `CHROME_DEVTOOLS_AXI_OWNER_ID`.
 */

import { randomUUID } from "node:crypto";
import type {
  BridgeCallPayload,
  BridgeClient,
  BridgeToolDescription,
} from "./bridge.js";

interface McpContentBlock {
  type?: string;
  text?: string;
}

interface McpStructuredPage {
  id: number;
  url?: string;
  selected?: boolean;
  isolatedContext?: string | null;
}

interface McpToolResult {
  content?: McpContentBlock[];
  structuredContent?: {
    pages?: McpStructuredPage[];
    [key: string]: unknown;
  };
  isError?: boolean;
}

interface OwnerContext {
  pages: Set<number>;
  cleanupPages: Set<number>;
  selected: number | undefined;
  isolatedContext: string | undefined;
}

function asToolResult(result: unknown): McpToolResult {
  if (result && typeof result === "object") {
    return result as McpToolResult;
  }
  return {};
}

function textOf(result: unknown): string {
  const res = asToolResult(result);
  return (res.content ?? [])
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

function validId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
}

function pageIds(result: unknown): Set<number> {
  const res = asToolResult(result);
  const entries = [...textOf(res).matchAll(/^\s*(\d+): (.*)$/gm)];
  const ids = entries.map((m) => Number(m[1]));
  if (ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Ambiguous page listing");
  }
  if (Object.hasOwn(res.structuredContent ?? {}, "pages")) {
    const pages = res.structuredContent?.pages;
    if (!Array.isArray(pages) || pages.some((p) => !p || !validId(p.id))) {
      throw new Error("Ambiguous structured page listing");
    }
    const structuredIds = pages.map((p) => p.id);
    if (
      new Set(structuredIds).size !== pages.length ||
      pages.length !== ids.length ||
      structuredIds.some((id) => !ids.includes(id))
    ) {
      throw new Error("Inconsistent text and structured page listing");
    }
    const contexts = new Map(
      entries.map((m) => [
        Number(m[1]),
        m[2].match(/ isolatedContext=([^\s]+)$/)?.[1],
      ]),
    );
    if (
      pages.some(
        (p) =>
          (p.isolatedContext != null &&
            typeof p.isolatedContext !== "string") ||
          contexts.get(p.id) !== (p.isolatedContext ?? undefined),
      )
    ) {
      throw new Error("Inconsistent text and structured page contexts");
    }
  }
  return new Set(ids);
}

function inOwnedContext(
  result: unknown,
  id: number,
  contextName: string | undefined,
): boolean {
  const res = asToolResult(result);
  const pages = res.structuredContent?.pages;
  if (contextName === undefined) {
    if (Array.isArray(pages)) {
      return pages.some((p) => p.id === id && p.isolatedContext == null);
    }
    return textOf(res)
      .split("\n")
      .some(
        (line) =>
          line.startsWith(`${id}: `) && !/\sisolatedContext=[^\s]+$/.test(line),
      );
  }
  if (Array.isArray(pages)) {
    return pages.some((p) => p.id === id && p.isolatedContext === contextName);
  }
  return textOf(res)
    .split("\n")
    .some(
      (line) =>
        line.startsWith(`${id}: `) &&
        line.endsWith(` isolatedContext=${contextName}`),
    );
}

export function shouldUseSharedDefaultContext(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT === "1") return false;
  if (env.CHROME_DEVTOOLS_AXI_ISOLATED_CONTEXT === "0") return true;
  return Boolean(
    env.CHROME_DEVTOOLS_AXI_BROWSER_URL ||
      env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1" ||
      env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR,
  );
}

export function ownerKey(owner: unknown): string {
  if (typeof owner !== "string" || !/^[a-zA-Z0-9_.:-]{8,200}$/.test(owner)) {
    throw new Error(
      "Explicit task owner required: CHROME_DEVTOOLS_AXI_OWNER_ID",
    );
  }
  return owner;
}

export class OwnedPageRouter {
  readonly bridgeId: string = randomUUID();
  requireOwnedRouting = false;
  private readonly owners = new Map<string, OwnerContext>();
  private readonly ownerQueues = new Map<string, Promise<unknown>>();
  private exclusiveChain: Promise<unknown> = Promise.resolve();
  private exclusivePending = 0;
  private readonly activeShared = new Set<Promise<unknown>>();
  private cachedTools: BridgeToolDescription[] | null = null;

  constructor(private readonly client: BridgeClient) {}

  run(payload: BridgeCallPayload): Promise<unknown> {
    const isExclusive =
      payload.name === "new_page" ||
      payload.name === "close_page" ||
      typeof payload.owner !== "string";
    if (isExclusive) {
      this.exclusivePending += 1;
      const prevEx = this.exclusiveChain;
      const task = (async () => {
        try {
          await prevEx;
          while (this.activeShared.size > 0) {
            await Promise.allSettled([...this.activeShared]);
          }
          return await this.call(payload);
        } finally {
          this.exclusivePending -= 1;
        }
      })();
      this.exclusiveChain = task.then(
        () => {},
        () => {},
      );
      return task;
    }
    const key = payload.owner as string;
    const prevOwner = this.ownerQueues.get(key) ?? Promise.resolve();
    const task = (async () => {
      await prevOwner;
      while (this.exclusivePending > 0) {
        await this.exclusiveChain;
      }
      const p = this.call(payload);
      const settled = p.then(
        () => {},
        () => {},
      );
      this.activeShared.add(settled);
      try {
        return await p;
      } finally {
        this.activeShared.delete(settled);
      }
    })();
    this.ownerQueues.set(
      key,
      task.then(
        () => {},
        () => {},
      ),
    );
    return task;
  }

  private async call({
    name,
    args = {},
    owner,
    bridgeId,
    roots,
  }: BridgeCallPayload): Promise<unknown> {
    if (bridgeId !== this.bridgeId) {
      throw new Error(
        bridgeId === undefined
          ? "Stale or unbound bridge instance (bridge is in owned-page mode; set CHROME_DEVTOOLS_AXI_OWNER_ID)"
          : "Stale or unbound bridge instance",
      );
    }
    if (!this.cachedTools) {
      this.cachedTools = (await this.client.listTools()).tools;
    }
    let tool = this.cachedTools.find((t) => t.name === name);
    if (!tool) {
      this.cachedTools = (await this.client.listTools()).tools;
      tool = this.cachedTools.find((t) => t.name === name);
    }
    if (!tool?.inputSchema?.properties) {
      throw new Error("Tool inputSchema unavailable");
    }
    const props = tool.inputSchema.properties;
    if (args.bringToFront === true) {
      throw new Error("Foreground activation is forbidden");
    }
    if (Object.hasOwn(args, "serviceWorkerId")) {
      throw new Error("Service-worker targets are outside owned-page context");
    }
    if (name === "list_pages") {
      return this.client.callTool({ name, arguments: args }, roots);
    }
    const pageScoped = Object.hasOwn(props, "pageId");
    if (name !== "new_page" && !pageScoped) {
      throw new Error(
        "Tool has no explicit owned-page inputSchema; implicit browser targets are forbidden",
      );
    }
    const key = ownerKey(owner);
    let context = this.owners.get(key);
    if (!context) {
      const isolatedContext = shouldUseSharedDefaultContext()
        ? undefined
        : `axi-owned-${randomUUID()}`;
      context = {
        pages: new Set(),
        cleanupPages: new Set(),
        selected: undefined,
        isolatedContext,
      };
      this.owners.set(key, context);
    }
    if (name === "new_page") {
      if (
        !Object.hasOwn(props, "background") ||
        (context.isolatedContext !== undefined &&
          !Object.hasOwn(props, "isolatedContext"))
      ) {
        throw new Error(
          "Backend cannot create a safely isolated background page",
        );
      }
      if (args.background === false) {
        throw new Error("Foreground page creation is forbidden");
      }
      if (Object.hasOwn(args, "isolatedContext")) {
        throw new Error("Caller may not override owned browser context");
      }
      const beforeListing = asToolResult(
        await this.client.callTool({ name: "list_pages", arguments: {} }),
      );
      if (beforeListing.isError) {
        throw new Error("Initial page listing failed; no ownership granted");
      }
      const before = pageIds(beforeListing);
      let result: unknown;
      let creationError: unknown;
      try {
        const newPageArgs: Record<string, unknown> = {
          ...args,
          background: true,
        };
        if (context.isolatedContext !== undefined) {
          newPageArgs.isolatedContext = context.isolatedContext;
        }
        result = await this.client.callTool(
          { name, arguments: newPageArgs },
          roots,
        );
      } catch (error) {
        creationError = error;
      }
      const alreadyTracked = (id: number): boolean =>
        context.pages.has(id) || context.cleanupPages.has(id);
      const listing = asToolResult(
        await this.client.callTool({ name: "list_pages", arguments: {} }),
      );
      if (listing.isError) {
        if (!creationError && !asToolResult(result).isError) {
          try {
            const rep = [...pageIds(result)].filter(
              (id) => !before.has(id) && !alreadyTracked(id),
            );
            if (
              rep.length === 1 &&
              inOwnedContext(result, rep[0], context.isolatedContext)
            ) {
              context.cleanupPages.add(rep[0]);
            }
          } catch {
            // Ignore malformed result when post-creation listing also failed.
          }
        }
        throw new Error(
          "Post-creation page listing failed; no ownership granted",
        );
      }
      const after = pageIds(listing);
      const newlyListed = [...after].filter((id) => !before.has(id));
      let created: number[] = [];
      let reported = new Set<number>();
      const resObj = asToolResult(result);
      if (!creationError && !resObj.isError) {
        try {
          reported = pageIds(result);
          created = newlyListed.filter(
            (id) =>
              !alreadyTracked(id) &&
              inOwnedContext(listing, id, context.isolatedContext) &&
              inOwnedContext(result, id, context.isolatedContext),
          );
        } catch {
          // Malformed creation results can establish cleanup authority only.
        }
      }
      if (created.length !== 1 || !reported.has(created[0])) {
        if (
          newlyListed.length === 1 &&
          !alreadyTracked(newlyListed[0]) &&
          inOwnedContext(listing, newlyListed[0], context.isolatedContext) &&
          (context.isolatedContext !== undefined ||
            reported.has(newlyListed[0]))
        ) {
          const id = newlyListed[0];
          context.cleanupPages.add(id);
          throw new Error(
            `Page creation failed or identity ambiguous; page ${id} retained for cleanup only`,
            { cause: creationError },
          );
        }
        throw new Error("New page identity ambiguous; no ownership granted", {
          cause: creationError,
        });
      }
      const id = created[0];
      context.pages.add(id);
      context.selected = id;
      return result;
    }

    const explicit = Object.hasOwn(args, "pageId");
    const id = explicit ? args.pageId : context.selected;
    if (!validId(id)) {
      throw new Error("Missing or invalid explicit owned page ID");
    }
    const cleanupOnly = context.cleanupPages.has(id);
    if (cleanupOnly && (name !== "close_page" || !explicit)) {
      throw new Error("Cleanup-only page permits explicit close_page only");
    }
    if (!context.pages.has(id) && !cleanupOnly) {
      throw new Error(
        "Page belongs to another task or was not created by this caller",
      );
    }
    if (
      name !== "select_page" &&
      name !== "close_page" &&
      explicit &&
      id !== context.selected
    ) {
      throw new Error(
        "Supplied page ID conflicts with caller-selected owned page",
      );
    }
    const listing = asToolResult(
      await this.client.callTool({ name: "list_pages", arguments: {} }),
    );
    if (listing.isError) {
      throw new Error(
        cleanupOnly
          ? "Cleanup page listing failed; ownership retained for cleanup"
          : "Page listing failed; ownership retained",
      );
    }
    const live = pageIds(listing);
    if (
      !live.has(id) ||
      !inOwnedContext(listing, id, context.isolatedContext)
    ) {
      context.pages.delete(id);
      context.cleanupPages.delete(id);
      if (context.selected === id) context.selected = undefined;
      throw new Error("Owned page is stale or closed");
    }
    const boundArgs: Record<string, unknown> = { ...args, pageId: id };
    if (name === "select_page") boundArgs.bringToFront = false;
    const result = await this.client.callTool(
      { name, arguments: boundArgs },
      roots,
    );
    if (asToolResult(result).isError) {
      return result;
    }
    if (name === "select_page") context.selected = id;
    if (name === "close_page") {
      const remainingListing = asToolResult(
        await this.client.callTool({ name: "list_pages", arguments: {} }),
      );
      if (remainingListing.isError) {
        throw new Error(
          "Page close could not be verified; ownership retained for cleanup",
        );
      }
      const remaining = pageIds(remainingListing);
      if (remaining.has(id)) {
        throw new Error(
          "Owned page was not closed; ownership retained for cleanup",
        );
      }
      context.pages.delete(id);
      context.cleanupPages.delete(id);
      if (context.selected === id) context.selected = undefined;
    }
    return result;
  }
}
