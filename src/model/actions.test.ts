import { describe, expect, it } from "vitest";
import type { ActionRequest, Interaction, Session } from "../core/types";
import { actionKey, buildAnswer, combinedQueue, folderOptions, hostChoice, hostLabel, initialDraft, newActionIds, visibleRows, withFolder, withHost } from "./actions";

const action = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  requestId: "act-1", title: "Start a session",
  rows: [{ label: "Project", value: "nexa" }, { label: "Folder", value: "/p/nexa" }, { label: "Model", value: "Sonnet" }],
  body: "Fix the search", folder: { path: "/p/nexa", options: ["/p/nexa", "/w/nexa"] },
  host: { value: "background", options: [{ id: "background", label: "Background" }] }, deadline: 1000, ...over,
});

describe("draft and answer", () => {
  it("starts from the request's folder and host", () => {
    expect(initialDraft(action())).toEqual({ folder: "/p/nexa", host: "background" });
    expect(initialDraft(action({ folder: null, host: null }))).toEqual({ folder: null, host: null });
  });
  it("takes a chosen folder, ignores a cancelled dialog", () => {
    const d = initialDraft(action());
    expect(withFolder(d, "/x/new").folder).toBe("/x/new");
    expect(withFolder(d, null)).toBe(d);
    expect(withFolder(d, "  ")).toBe(d);
  });
  it("only takes a host the request offers", () => {
    const a = action({ host: { value: "background", options: [{ id: "background", label: "Background" }, { id: "iterm", label: "iTerm" }] } });
    const d = initialDraft(a);
    expect(withHost(a, d, "iterm").host).toBe("iterm");
    expect(withHost(a, d, "rm -rf")).toBe(d);
  });
  it("allow sends the shown folder and host, deny only the verdict", () => {
    const a = action();
    const d = withFolder(initialDraft(a), "/x/new");
    expect(buildAnswer(a, d, true)).toEqual({ allow: true, folder: "/x/new", host: "background" });
    expect(buildAnswer(a, d, false)).toEqual({ allow: false });
  });
  it("leaves out what the card did not offer", () => {
    const a = action({ folder: null, host: null });
    expect(buildAnswer(a, initialDraft(a), true)).toEqual({ allow: true });
  });
});

describe("what the card shows", () => {
  it("hides the select for a single host, shows its label", () => {
    const a = action();
    expect(hostChoice(a)).toBe(false);
    expect(hostLabel(a, initialDraft(a))).toBe("Background");
    expect(hostChoice(action({ host: { value: "a", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }))).toBe(true);
  });
  it("lists the folder options except the one shown", () => {
    const a = action();
    expect(folderOptions(a, initialDraft(a))).toEqual(["/w/nexa"]);
    expect(folderOptions(a, withFolder(initialDraft(a), "/w/nexa"))).toEqual(["/p/nexa"]);
    expect(folderOptions(action({ folder: null }), { folder: null, host: null })).toEqual([]);
  });
  it("drops the rows the card edits itself", () => {
    expect(visibleRows(action()).map((r) => r.label)).toEqual(["Project", "Model"]);
    expect(visibleRows(action({ folder: null, host: null })).map((r) => r.label)).toEqual(["Project", "Folder", "Model"]);
  });
});

const session = (id: string): Session => ({ id } as Session);
const approval = (requestId: string): Interaction => ({ kind: "approval", requestId, tool: "Bash", target: "ls", agentId: null, deadline: 1 });

describe("combinedQueue", () => {
  const sq = [{ session: session("s1"), item: approval("r1") }, { session: session("s2"), item: approval("r2") }];
  const id = (e: ReturnType<typeof combinedQueue>[number]) => (e.kind === "action" ? e.action.requestId : e.item.requestId);

  it("puts the chat's requests before the sessions' items, in arrival order", () => {
    const q = combinedQueue([action({ requestId: "a1" }), action({ requestId: "a2" })], sq, null);
    expect(q.map(id)).toEqual(["a1", "a2", "r1", "r2"]);
  });
  it("keeps the card on screen at the head until it resolves", () => {
    const q = combinedQueue([action({ requestId: "a1" })], sq, "r2");
    expect(q.map(id)).toEqual(["r2", "a1", "r1"]);
    expect(combinedQueue([action({ requestId: "a1" }), action({ requestId: "a2" })], [], "a2").map(id)).toEqual(["a2", "a1"]);
  });
  it("is empty without anything waiting, and falls back when the shown card is gone", () => {
    expect(combinedQueue([], [], "x")).toEqual([]);
    expect(combinedQueue([action({ requestId: "a1" })], sq, "gone").map(id)).toEqual(["a1", "r1", "r2"]);
  });
});

describe("newActionIds", () => {
  it("reports only requests that were not there before", () => {
    expect(newActionIds([action({ requestId: "a" })], [action({ requestId: "a" }), action({ requestId: "b" })])).toEqual(["b"]);
    expect(newActionIds([], [])).toEqual([]);
  });
});

describe("actionKey", () => {
  it("Escape denies, Enter never answers by itself", () => {
    expect(actionKey("Escape", "BUTTON")).toBe("deny");
    expect(actionKey("Escape", "DIV")).toBe("deny");
    expect(actionKey("Enter", "BUTTON")).toBeNull();
    expect(actionKey("Enter", "INPUT")).toBeNull();
  });
  it("leaves Escape to an open select", () => {
    expect(actionKey("Escape", "select")).toBeNull();
  });
});
