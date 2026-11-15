import { expect, test } from "bun:test";
import { subtotal, total } from "../src/cart";

const items = [
  { name: "Notebook", cents: 1200, qty: 2 },
  { name: "Pen", cents: 300, qty: 1 },
];

test("subtotal adds every line", () => {
  expect(subtotal(items)).toBe(2700);
});

test("a flat coupon comes off the subtotal", () => {
  expect(total(items, { kind: "flat", cents: 500 })).toBe(2200);
});

test("a percent coupon takes that share of the subtotal", () => {
  expect(total(items, { kind: "percent", percent: 10 })).toBe(2430);
});

test("a coupon never takes the total below zero", () => {
  expect(total(items, { kind: "flat", cents: 5000 })).toBe(0);
});
