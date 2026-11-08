import { expect, test } from "bun:test";
import { parseMessageBlock } from "../../../src/engine/messaging/block";

const fence = (json: string, tag = "atrium-message") => "```" + tag + "\n" + json + "\n```";

test("a valid block is read and taken out of the body", () => {
  const text = `Here's a draft.\n\n${fence('{"to":"Dana","text":"you free sat?"}')}`;
  expect(parseMessageBlock(text)).toEqual({ to: "Dana", text: "you free sat?", body: "Here's a draft." });
});

test("the last block counts", () => {
  const text = `${fence('{"to":"Dana","text":"first"}')}\nActually:\n${fence('{"to":"Dana","text":"second"}')}`;
  expect(parseMessageBlock(text)).toMatchObject({ text: "second", body: `${fence('{"to":"Dana","text":"first"}')}\nActually:` });
});

test("other tags and bad JSON are ignored", () => {
  expect(parseMessageBlock(fence('{"to":"Dana","text":"hi"}', "atrium-messages"))).toBeNull();
  expect(parseMessageBlock(fence('{"to":"Dana","text":"hi"}', "json"))).toBeNull();
  expect(parseMessageBlock(fence('{"to":"Dana",'))).toBeNull();
  expect(parseMessageBlock(fence('{"to":5,"text":"hi"}'))).toBeNull();
});

test("extra fields are ignored", () => {
  expect(parseMessageBlock(fence('{"to":"Dana","text":"hi","approved":true,"handle":"x"}'))).toEqual({ to: "Dana", text: "hi", body: "" });
});

test("a long name or hidden text is refused", () => {
  expect(parseMessageBlock(fence(JSON.stringify({ to: "x".repeat(300), text: "hi" })))).toBeNull();
  expect(parseMessageBlock(fence(JSON.stringify({ to: "Dana", text: "a‮b" })))).toBeNull();
});

test("control characters are stripped from the name", () => {
  expect(parseMessageBlock(fence(JSON.stringify({ to: "Ta\nlal‮", text: "hi" })))?.to).toBe("Dana");
});

test("a group block names the chat, the people, or both, and its to is ignored", () => {
  expect(parseMessageBlock(`Draft.\n${fence('{"group":"Hike crew","text":"saturday 8am?"}')}`)).toEqual({ group: { name: "Hike crew", people: [] }, text: "saturday 8am?", body: "Draft." });
  expect(parseMessageBlock(fence('{"people":["Sam","Priya","Sam"],"text":"hi"}'))).toEqual({ group: { name: null, people: ["Sam", "Priya"] }, text: "hi", body: "" });
  expect(parseMessageBlock(fence('{"to":"Dana","group":"Hike crew","people":["Sam"],"text":"hi","chatId":"x"}'))).toEqual({ group: { name: "Hike crew", people: ["Sam"] }, text: "hi", body: "" });
});

test("a bad group block is refused, never turned into a person text", () => {
  expect(parseMessageBlock(fence('{"to":"Dana","group":5,"text":"hi"}'))).toBeNull();
  expect(parseMessageBlock(fence('{"to":"Dana","people":"Sam","text":"hi"}'))).toBeNull();
  expect(parseMessageBlock(fence('{"to":"Dana","group":"","people":[],"text":"hi"}'))).toBeNull();
  expect(parseMessageBlock(fence(JSON.stringify({ people: Array.from({ length: 13 }, (_, i) => `P${i}`), text: "hi" })))).toBeNull();
  expect(parseMessageBlock(fence(JSON.stringify({ group: "Hike · +1 416 555 0134", text: "hi" })))).toBeNull();
  expect(parseMessageBlock(fence(JSON.stringify({ people: ["Sam", "x".repeat(81)], text: "hi" })))).toBeNull();
});
