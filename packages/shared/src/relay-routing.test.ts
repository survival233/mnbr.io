import { describe, it, expect } from "vitest";
import { relayRoute, RelayRoutingState } from "./relay-routing.js";
const group = { data: { chat: { id: "cnv_group", type: "group" }, sender_handle: { type: "user" } } };
describe("Relay routing", () => {
  it("elects one agent for a group, then keeps short replies with it", () => {
    expect(relayRoute(group, "I am flying to Accra")).toMatchObject({ role: "traveler" });
    expect(relayRoute(group, "yes", "traveler")).toMatchObject({ role: "traveler" });
    expect(relayRoute(group, "hi")).toMatchObject({ role: "shopper" });
    expect(relayRoute(group, "@shopper: buy shoes", "traveler")).toEqual({ role: "shopper", text: "buy shoes" });
  });
  it("preserves Traveler direct chats and supports explicit shared IDs", () => {
    const direct = { data: { chat: { id: "cnv_group" } } };
    expect(relayRoute(direct, "hi", undefined, "traveler")?.role).toBe("traveler");
    expect(relayRoute(direct, "hi", undefined, "traveler", ["cnv_group"])?.role).toBe("shopper");
    expect(relayRoute(group, "@traveller tomorrow", "shopper")).toEqual({ role: "traveler", text: "tomorrow" });
  });
  it("ignores bot and outbound echoes", () => {
    expect(relayRoute({ data: { sender_handle: { type: "agent" } } }, "hi")).toBeNull();
    expect(relayRoute({ data: { message: { direction: "outbound" } } }, "hi")).toBeNull();
  });
});

it("restores each participant's selected agent after restart", () => {
  let saved = {};
  const store = { load: () => saved, save: (value: Record<string, "shopper" | "traveler">) => { saved = value; } };
  const first = new RelayRoutingState(store);
  first.route(group, "@traveler hello", "cnv_group", "usr_alice", "shopper", []);
  const restored = new RelayRoutingState(store);
  expect(restored.route(group, "yes", "cnv_group", "usr_alice", "shopper", [])?.role).toBe("traveler");
  expect(restored.route(group, "yes", "cnv_group", "usr_bob", "shopper", [])?.role).toBe("shopper");
});
