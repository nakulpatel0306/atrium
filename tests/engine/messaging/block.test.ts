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
