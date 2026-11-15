export type Item = { name: string; cents: number; qty: number };
export type Coupon = { kind: "flat"; cents: number } | { kind: "percent"; percent: number };

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);
}

// The total after a coupon, never below zero.
export function total(items: Item[], coupon?: Coupon): number {
  const sum = subtotal(items);
  if (!coupon) return sum;
  const off = coupon.kind === "flat" ? coupon.cents : coupon.percent;
  return Math.max(0, sum - off);
}
